// Projects (SPEC 프로젝트): list/create/get/update/delete(trash)/restore + members.
import {
  decide,
  memberPutSchema,
  projectCreateBodySchema,
  projectDeleteSchema,
  projectUpdateSchema,
  TRASH_RETENTION_DAYS,
  type MemberDto,
  type ProjectDto,
  type ProjectOrigin,
  type ProjectRole,
  type ProjectVisibility,
  type TokenPermission,
} from '@euta-cloud/shared';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { DAY_MS } from '../clock.js';
import type { AppContext } from '../context.js';
import { environments, projectMembers, projects, users } from '../db/schema.js';
import { AppError, notFound, parse } from '../http.js';
import { actorOf, canFor, projectAccess, requirePrincipal, type ProjectRow } from '../services/access.js';
import { record } from '../services/activity.js';
import { dailyUsage } from '../services/daily-cap.js';
import { lockProject, removeMember, setMemberRole } from '../services/members.js';
import { disableProjectSchedules } from './schedules.js';

type P = { Params: { id: string } };

export const ROLE_LABEL: Record<ProjectRole, string> = { owner: '소유자', editor: '편집자', runner: '실행자', viewer: '보기' };

/**
 * The Teams webhook URL carries a SAS `sig` (a secret): only callers who may change project settings
 * (`project.update` — editor+, read_write token) get it; everyone gets `teamsWebhookConfigured`.
 */
export interface ProjectMeta {
  /** The caller has a project_members row. */
  isMember: boolean;
  /** Birth-record creator name (null when unknown / account gone). */
  creatorName: string | null;
}

export function projectDto(p: ProjectRow, myRole: ProjectRole, tokenPermission: TokenPermission | undefined, extra: Partial<ProjectDto> = {}, meta: ProjectMeta = { isMember: myRole !== 'viewer', creatorName: null }): ProjectDto {
  const showWebhook = decide({ role: myRole, action: 'project.update', tokenPermission });
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    browser: p.browser,
    testRules: p.testRules,
    ...(showWebhook ? { teamsWebhookUrl: p.teamsWebhookUrl } : {}),
    teamsWebhookConfigured: !!p.teamsWebhookUrl,
    defaultEnvironmentId: p.defaultEnvironmentId,
    runTimeLimitSec: p.runTimeLimitSec,
    notify: p.notifySettings,
    dailyRunCap: p.dailyRunCap,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    ...(p.deletedAt ? { deletedAt: p.deletedAt.toISOString() } : {}),
    myRole,
    isMember: meta.isMember,
    visibility: p.visibility as ProjectVisibility,
    birth: {
      origin: p.origin as ProjectOrigin,
      originLocalId: p.originLocalId,
      createdBy: p.createdBy ? { id: p.createdBy, name: meta.creatorName ?? '' } : null,
      createdAt: p.createdAt.toISOString(),
    },
    ...extra,
  };
}

/** Creator names for a set of projects (birth record `createdBy`). */
export async function creatorNames(db: AppContext['db'], rows: ProjectRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
  if (!ids.length) return new Map();
  const us = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return new Map(us.map((u) => [u.id, u.name]));
}

/** Latest top-level run per project (list column "최근 실행"). */
export async function lastRuns(db: AppContext['db'], ids: string[]): Promise<Map<string, NonNullable<ProjectDto['lastRun']>>> {
  const last = new Map<string, NonNullable<ProjectDto['lastRun']>>();
  if (!ids.length) return last;
  const lr = await db.execute<{ project_id: string; id: string; status: string; flaky: boolean; queued_at: Date; finished_at: Date | null }>(
    sql`select distinct on (project_id) project_id, id, status, flaky, created_at as queued_at, finished_at from runs
        where parent_run_id is null and project_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        order by project_id, created_at desc, id desc`,
  );
  for (const r of lr.rows) {
    last.set(r.project_id, { id: r.id, status: r.status, flaky: r.flaky, queuedAt: new Date(r.queued_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null });
  }
  return last;
}

/** Visible to the caller: org-wide projects, plus members-only ones they belong to (stage 15). */
export const visibleTo = (memberProjectIds: string[]) =>
  memberProjectIds.length ? or(eq(projects.visibility, 'org'), inArray(projects.id, memberProjectIds)) : eq(projects.visibility, 'org');

export async function projectRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, feed } = ctx;

  app.get<{ Querystring: { scope?: string; trashed?: string } }>('/api/projects', async (req) => {
    const p = requirePrincipal(req);
    const mine = await db.select({ projectId: projectMembers.projectId, role: projectMembers.role }).from(projectMembers).where(eq(projectMembers.userId, p.user.id));
    const roles = new Map(mine.map((m) => [m.projectId, m.role as ProjectRole]));
    if (req.query.trashed === '1' || req.query.trashed === 'true') {
      // Trash: only projects I own, still inside the restore window.
      const owned = mine.filter((m) => m.role === 'owner').map((m) => m.projectId);
      if (!owned.length) return { projects: [] };
      const cutoff = new Date(ctx.clock.now().getTime() - TRASH_RETENTION_DAYS * DAY_MS);
      const rows = await db
        .select()
        .from(projects)
        .where(and(inArray(projects.id, owned), isNotNull(projects.deletedAt), gt(projects.deletedAt, cutoff)))
        .orderBy(desc(projects.deletedAt));
      const names = await creatorNames(db, rows);
      return { projects: rows.map((r) => projectDto(r, 'owner', p.tokenPermission, {}, { isMember: true, creatorName: r.createdBy ? (names.get(r.createdBy) ?? null) : null })) };
    }
    const scopeMine = req.query.scope === 'mine';
    if (scopeMine && !roles.size) return { projects: [] };
    const rows = await db
      .select()
      .from(projects)
      .where(and(isNull(projects.deletedAt), scopeMine ? inArray(projects.id, [...roles.keys()]) : visibleTo([...roles.keys()])))
      .orderBy(asc(projects.name));
    // Latest top-level run per project (list column "최근 실행").
    const last = await lastRuns(db, rows.map((r) => r.id));
    const names = await creatorNames(db, rows);
    return {
      projects: rows.map((r) =>
        projectDto(r, roles.get(r.id) ?? 'viewer', p.tokenPermission, { lastRun: last.get(r.id) ?? null }, { isMember: roles.has(r.id), creatorName: r.createdBy ? (names.get(r.createdBy) ?? null) : null }),
      ),
    };
  });

  app.post('/api/projects', async (req, reply) => {
    const p = requirePrincipal(req);
    // Creating a project is open to every member, but a read token cannot write.
    if (p.tokenPermission === 'read') throw new AppError(403, 'FORBIDDEN', 'this token is read-only');
    const body = parse(projectCreateBodySchema, req.body);
    const actor = actorOf(p);
    const meta = { isMember: true, creatorName: p.user.name };
    if (body.origin === 'app') {
      // "이어서 하기": the same person uploading the same local project again gets the half-made project back.
      const [existing] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.createdBy, p.user.id), eq(projects.origin, 'app'), eq(projects.originLocalId, body.originLocalId!), isNull(projects.deletedAt)));
      if (existing) {
        const role = (await db.select({ role: projectMembers.role }).from(projectMembers).where(and(eq(projectMembers.projectId, existing.id), eq(projectMembers.userId, p.user.id))))[0]?.role as ProjectRole | undefined;
        if (role) {
          reply.status(200);
          return projectDto(existing, role, p.tokenPermission, { can: canFor(role, true, p.tokenPermission), resumed: true }, meta);
        }
      }
    }
    const row = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(projects)
        .values({
          name: body.name,
          description: body.description ?? '',
          browser: body.browser ?? { engine: 'chromium' },
          testRules: body.testRules ?? '',
          teamsWebhookUrl: body.teamsWebhookUrl ?? null,
          createdBy: p.user.id,
          origin: body.origin,
          originLocalId: body.origin === 'app' ? body.originLocalId! : null,
          visibility: 'org',
        })
        .returning();
      await tx.insert(projectMembers).values({ projectId: created!.id, userId: p.user.id, role: 'owner', addedBy: p.user.id });
      await record(tx, feed, actor, {
        projectId: created!.id,
        kind: 'project.created',
        summary: `프로젝트 만들기: ${body.name} (${body.origin === 'app' ? '앱에서 올림' : '웹'})`,
        targetType: 'project',
        targetId: created!.id,
        details: { origin: body.origin },
      });
      return created!;
    });
    reply.status(201);
    return projectDto(row, 'owner', p.tokenPermission, { can: canFor('owner', true, p.tokenPermission) }, meta);
  });

  app.get<P>('/api/projects/:id', async (req) => {
    const { project, role, principal, isMember, creatorName } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const usage = await dailyUsage(db, project.id, ctx.clock.now());
    return projectDto(project, role, principal.tokenPermission, { can: canFor(role, isMember, principal.tokenPermission), dailyRunUsage: { ...usage, cap: project.dailyRunCap } }, { isMember, creatorName });
  });

  app.patch<P>('/api/projects/:id', async (req) => {
    const { project, role, principal, isMember, creatorName } = await projectAccess(ctx, req, req.params.id, 'project.update');
    const body = parse(projectUpdateSchema, req.body);
    if (body.defaultEnvironmentId) {
      const [env] = await db.select({ id: environments.id }).from(environments).where(and(eq(environments.id, body.defaultEnvironmentId), eq(environments.projectId, project.id)));
      if (!env) throw new AppError(422, 'VALIDATION_FAILED', 'default environment does not belong to this project', [{ path: 'defaultEnvironmentId', message: 'unknown environment' }]);
    }
    const changes = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.browser !== undefined ? { browser: body.browser } : {}),
      ...(body.testRules !== undefined ? { testRules: body.testRules } : {}),
      ...(body.teamsWebhookUrl !== undefined ? { teamsWebhookUrl: body.teamsWebhookUrl } : {}),
      ...(body.defaultEnvironmentId !== undefined ? { defaultEnvironmentId: body.defaultEnvironmentId } : {}),
      ...(body.runTimeLimitSec !== undefined ? { runTimeLimitSec: body.runTimeLimitSec } : {}),
      ...(body.notify !== undefined ? { notifySettings: { ...project.notifySettings, ...body.notify } } : {}),
      ...(body.dailyRunCap !== undefined ? { dailyRunCap: body.dailyRunCap } : {}),
    };
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx.update(projects).set({ ...changes, updatedAt: ctx.clock.now() }).where(eq(projects.id, project.id)).returning();
      await record(tx, feed, actorOf(principal), {
        projectId: project.id,
        kind: 'project.updated',
        summary: `프로젝트 설정 변경: ${Object.keys(changes).join(', ') || '(없음)'}`,
        targetType: 'project',
        targetId: project.id,
        details: { fields: Object.keys(changes) },
      });
      return u!;
    });
    const usage = await dailyUsage(db, project.id, ctx.clock.now());
    return projectDto(updated, role, principal.tokenPermission, { can: canFor(role, isMember, principal.tokenPermission), dailyRunUsage: { ...usage, cap: updated.dailyRunCap } }, { isMember, creatorName });
  });

  app.delete<P>('/api/projects/:id', async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'project.delete');
    const body = parse(projectDeleteSchema, req.body);
    if (body.confirmName !== project.name) throw new AppError(422, 'VALIDATION_FAILED', 'type the project name to confirm deletion', [{ path: 'confirmName', message: 'does not match the project name' }]);
    await db.transaction(async (tx) => {
      await tx.update(projects).set({ deletedAt: ctx.clock.now(), deletedBy: principal.user.id }).where(eq(projects.id, project.id));
      await disableProjectSchedules(tx, project.id, ctx.clock.now());
      await record(tx, feed, actorOf(principal), { projectId: project.id, kind: 'project.deleted', summary: `프로젝트 삭제(휴지통): ${project.name}`, targetType: 'project', targetId: project.id });
    });
    return reply.status(204).send();
  });

  app.post<P>('/api/projects/:id/restore', async (req) => {
    const { project, role, principal, isMember, creatorName } = await projectAccess(ctx, req, req.params.id, 'project.restore', { includeTrashed: true });
    if (!project.deletedAt) throw new AppError(409, 'CONFLICT', 'project is not in the trash');
    if (ctx.clock.now().getTime() - project.deletedAt.getTime() > TRASH_RETENTION_DAYS * DAY_MS) throw notFound('project');
    const restored = await db.transaction(async (tx) => {
      const [r] = await tx.update(projects).set({ deletedAt: null, deletedBy: null, updatedAt: ctx.clock.now() }).where(eq(projects.id, project.id)).returning();
      await record(tx, feed, actorOf(principal), { projectId: project.id, kind: 'project.restored', summary: `프로젝트 복원: ${project.name}`, targetType: 'project', targetId: project.id });
      return r!;
    });
    return projectDto(restored, role, principal.tokenPermission, {}, { isMember, creatorName });
  });

  // ── Members
  const memberRows = (projectId: string, userId?: string) =>
    db
      .select({ userId: projectMembers.userId, role: projectMembers.role, addedAt: projectMembers.addedAt, email: users.email, name: users.name, status: users.status })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(and(eq(projectMembers.projectId, projectId), userId ? eq(projectMembers.userId, userId) : undefined))
      .orderBy(asc(users.name));
  const memberDto = (m: Awaited<ReturnType<typeof memberRows>>[number]): MemberDto => ({
    userId: m.userId,
    email: m.email,
    name: m.name,
    role: m.role as MemberDto['role'],
    active: m.status === 'active',
    addedAt: m.addedAt.toISOString(),
  });

  app.get<P>('/api/projects/:id/members', async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    return { members: (await memberRows(project.id)).map(memberDto) };
  });

  app.get<{ Params: { id: string; userId: string } }>('/api/projects/:id/members/:userId', async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const [m] = await memberRows(project.id, req.params.userId);
    if (!m) throw notFound('member');
    return memberDto(m);
  });

  app.put<{ Params: { id: string; userId: string } }>('/api/projects/:id/members/:userId', async (req) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'member.manage');
    const body = parse(memberPutSchema, req.body);
    const [target] = await db.select({ id: users.id, name: users.name, status: users.status }).from(users).where(eq(users.id, req.params.userId));
    if (!target) throw notFound('user');
    if (target.status !== 'active') throw new AppError(409, 'CONFLICT', 'only active members of the organization can be invited');
    await db.transaction(async (tx) => {
      await lockProject(tx, project.id);
      const prev = await setMemberRole(tx, project.id, target.id, body.role, principal.user.id);
      if (prev === body.role) return;
      await record(tx, feed, actorOf(principal), {
        projectId: project.id,
        kind: prev ? 'member.role_changed' : 'member.invited',
        summary: prev ? `구성원 역할 변경: ${target.name} ${ROLE_LABEL[prev]} → ${ROLE_LABEL[body.role]}` : `구성원 초대: ${target.name} (${ROLE_LABEL[body.role]})`,
        targetType: 'member',
        targetId: target.id,
        details: { role: body.role, ...(prev ? { previousRole: prev } : {}) },
      });
    });
    const [m] = await memberRows(project.id, target.id);
    return memberDto(m!);
  });

  app.delete<{ Params: { id: string; userId: string } }>('/api/projects/:id/members/:userId', async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'member.manage');
    await db.transaction(async (tx) => {
      await lockProject(tx, project.id);
      const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, req.params.userId));
      const prev = await removeMember(tx, project.id, req.params.userId);
      if (!prev) throw notFound('member');
      await record(tx, feed, actorOf(principal), { projectId: project.id, kind: 'member.removed', summary: `구성원 내보내기: ${u?.name ?? req.params.userId}`, targetType: 'member', targetId: req.params.userId, details: { previousRole: prev } });
    });
    return reply.status(204).send();
  });
}
