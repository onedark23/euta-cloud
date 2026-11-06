// Stage 15 "한 프로젝트 + 권한" (SPEC_클라우드-계정-프로젝트 "만들기·공개·구성원", ARCH 권한):
// visibility · access requests · leave · ownership transfer · merge gate · receive list (app) ·
// admin "소유자 없는 프로젝트". Every project-scoped check goes through projectAccess (members-only → 404).
import {
  ACCESS_REQUEST_EXPIRY_DAYS,
  accessRequestApproveSchema,
  accessRequestCreateSchema,
  accessRequestListQuerySchema,
  adminAssignOwnerSchema,
  decide,
  mergeSchema,
  ROLE_RANK,
  transferSchema,
  visibilityPutSchema,
  type AccessRequestDto,
  type AccessRequestStatus,
  type MemberDto,
  type OwnerlessProjectDto,
  type ProjectRole,
  type ReceivableProjectDto,
  type RequestableRole,
} from '@euta-cloud/shared';
import { aliasedTable, and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DAY_MS } from '../clock.js';
import type { AppContext } from '../context.js';
import type { Db, DbOrTx } from '../db/index.js';
import { accessRequests, projectMembers, projects, users } from '../db/schema.js';
import { AppError, forbidden, notFound, parse } from '../http.js';
import { actorOf, canFor, projectAccess, requireAdmin, requirePrincipal, type Actor, type ProjectRow } from '../services/access.js';
import { record } from '../services/activity.js';
import { currentRole, lockProject, removeMember, setMemberRole } from '../services/members.js';
import { insertUserEvents } from '../services/user-events.js';
import { creatorNames, lastRuns, projectDto, ROLE_LABEL, visibleTo } from './projects.js';

type P = { Params: { id: string } };
type PR = { Params: { id: string; requestId: string } };

/** Open requests past their expiry become `expired` (lazy; purge sweeps the rest). */
export async function expireAccessRequests(db: DbOrTx, now: Date, where: { projectId?: string; userId?: string } = {}): Promise<number> {
  const res = await db
    .update(accessRequests)
    .set({ status: 'expired' })
    .where(
      and(
        eq(accessRequests.status, 'open'),
        lte(accessRequests.expiresAt, now),
        where.projectId ? eq(accessRequests.projectId, where.projectId) : undefined,
        where.userId ? eq(accessRequests.userId, where.userId) : undefined,
      ),
    );
  return res.rowCount ?? 0;
}

const requester = aliasedTable(users, 'requester');
const decider = aliasedTable(users, 'decider');

interface RequestRow {
  r: typeof accessRequests.$inferSelect;
  projectName: string;
  uName: string;
  uEmail: string;
  dName: string | null;
}

async function requestRows(db: DbOrTx, where: ReturnType<typeof and>, limit = 100): Promise<RequestRow[]> {
  return (db as Db)
    .select({ r: accessRequests, projectName: projects.name, uName: requester.name, uEmail: requester.email, dName: decider.name })
    .from(accessRequests)
    .innerJoin(projects, eq(projects.id, accessRequests.projectId))
    .innerJoin(requester, eq(requester.id, accessRequests.userId))
    .leftJoin(decider, eq(decider.id, accessRequests.decidedBy))
    .where(where)
    .orderBy(desc(accessRequests.createdAt))
    .limit(limit);
}

function requestDto(x: RequestRow): AccessRequestDto {
  const r = x.r;
  return {
    id: r.id,
    projectId: r.projectId,
    projectName: x.projectName,
    user: { id: r.userId, name: x.uName, email: x.uEmail },
    role: r.role as RequestableRole,
    memo: r.memo,
    status: r.status as AccessRequestStatus,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    decidedBy: r.decidedBy ? { id: r.decidedBy, name: x.dName ?? '' } : null,
    grantedRole: (r.grantedRole as ProjectRole | null) ?? null,
  };
}

async function loadRequest(db: DbOrTx, projectId: string, requestId: string) {
  const [row] = await requestRows(db, and(eq(accessRequests.id, requestId), eq(accessRequests.projectId, projectId)), 1);
  if (!row) throw notFound('access request');
  return row;
}

const compact = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();

/**
 * Merge gate (SPEC 합치기): origin `app` + same local id + owner; `unknown` + owner + the old local
 * link record pointing at this project (filled to `app` once on merge); `web` never.
 */
function mergeRejection(project: ProjectRow, body: { localProjectId: string; uploadedTo?: { projectId: string; localId: string } }): AppError | null {
  if (project.origin === 'web') return new AppError(403, 'ORIGIN_MISMATCH', 'a project created on the web cannot take a local project — receive it instead', { reason: 'web_origin' });
  if (project.origin === 'app') {
    if (project.originLocalId !== body.localProjectId) return new AppError(403, 'ORIGIN_MISMATCH', 'this cloud project was uploaded from a different local project', { reason: 'local_id_mismatch' });
    return null;
  }
  const link = body.uploadedTo;
  if (!link || link.projectId !== project.id || compact(link.localId) !== compact(project.id)) {
    return new AppError(403, 'ORIGIN_MISMATCH', 'the local link record does not point at this cloud project', { reason: 'link_mismatch' });
  }
  return null;
}

const adminActor = (p: { user: { id: string; name: string } }): Actor => ({ type: 'user', id: p.user.id, label: `관리자 (${p.user.name})` });

export async function accessRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, feed } = ctx;
  const now = () => ctx.clock.now();

  // ── Visibility (owner) ─────────────────────────────────────────────────────
  app.put<P>('/api/projects/:id/visibility', async (req) => {
    const { project, role, principal, isMember, creatorName } = await projectAccess(ctx, req, req.params.id, 'project.visibility');
    const body = parse(visibilityPutSchema, req.body);
    if (body.visibility === project.visibility) return projectDto(project, role, principal.tokenPermission, { can: canFor(role, isMember, principal.tokenPermission) }, { isMember, creatorName });
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx.update(projects).set({ visibility: body.visibility, updatedAt: now() }).where(eq(projects.id, project.id)).returning();
      await record(tx, feed, actorOf(principal), {
        projectId: project.id,
        kind: 'project.visibility_changed',
        summary: `공개 범위 변경: ${body.visibility === 'org' ? '조직 공개' : '구성원만'}`,
        targetType: 'project',
        targetId: project.id,
        details: { visibility: body.visibility, previous: project.visibility },
      });
      return u!;
    });
    return projectDto(updated, role, principal.tokenPermission, { can: canFor(role, isMember, principal.tokenPermission) }, { isMember, creatorName });
  });

  // ── Access requests ────────────────────────────────────────────────────────
  app.post<P>('/api/projects/:id/access-requests', async (req, reply) => {
    const { project, role, principal } = await projectAccess(ctx, req, req.params.id, 'access.request');
    const body = parse(accessRequestCreateSchema, req.body);
    if (ROLE_RANK[body.role] <= ROLE_RANK[role]) throw new AppError(409, 'ALREADY_HAS_ROLE', `you are already ${role} — request a higher role`);
    const at = now();
    const id = await db.transaction(async (tx) => {
      await expireAccessRequests(tx, at, { projectId: project.id, userId: principal.user.id });
      const [open] = await tx
        .select({ id: accessRequests.id })
        .from(accessRequests)
        .where(and(eq(accessRequests.projectId, project.id), eq(accessRequests.userId, principal.user.id), eq(accessRequests.status, 'open')));
      if (open) throw new AppError(409, 'REQUEST_OPEN', 'you already have an open request for this project', { requestId: open.id });
      const inserted = await tx
        .insert(accessRequests)
        .values({ projectId: project.id, userId: principal.user.id, role: body.role, memo: body.memo ?? '', createdAt: at, expiresAt: new Date(at.getTime() + ACCESS_REQUEST_EXPIRY_DAYS * DAY_MS) })
        .onConflictDoNothing()
        .returning({ id: accessRequests.id });
      if (!inserted[0]) throw new AppError(409, 'REQUEST_OPEN', 'you already have an open request for this project');
      const rid = inserted[0].id;
      await record(tx, feed, actorOf(principal), {
        projectId: project.id,
        kind: 'access.requested',
        summary: `권한 요청: ${principal.user.name} → ${ROLE_LABEL[body.role]}${body.memo ? ` — ${body.memo}` : ''}`,
        targetType: 'access_request',
        targetId: rid,
        details: { role: body.role, userId: principal.user.id },
      });
      // Owners get an app notification (last statement: the user-event lock is held to commit).
      const owners = await tx
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(and(eq(projectMembers.projectId, project.id), eq(projectMembers.role, 'owner'), eq(users.status, 'active')));
      await insertUserEvents(
        tx,
        owners.map((o) => ({
          userId: o.userId,
          projectId: project.id,
          runId: null,
          kind: 'access.requested',
          data: { projectName: project.name, requestId: rid, requester: { id: principal.user.id, name: principal.user.name }, role: body.role, memo: body.memo ?? '' },
          at,
        })),
      );
      return rid;
    });
    reply.status(201);
    return requestDto(await loadRequest(db, project.id, id));
  });

  app.get<P & { Querystring: Record<string, string> }>('/api/projects/:id/access-requests', async (req) => {
    const { project, role, principal } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const q = parse(accessRequestListQuerySchema, req.query);
    await expireAccessRequests(db, now(), { projectId: project.id });
    const manage = decide({ role, action: 'member.manage', tokenPermission: principal.tokenPermission });
    const rows = await requestRows(
      db,
      and(eq(accessRequests.projectId, project.id), manage ? undefined : eq(accessRequests.userId, principal.user.id), q.status ? eq(accessRequests.status, q.status) : undefined),
    );
    return { requests: rows.map(requestDto) };
  });

  app.get<{ Querystring: Record<string, string> }>('/api/me/access-requests', async (req) => {
    const p = requirePrincipal(req);
    const q = parse(accessRequestListQuerySchema, req.query);
    await expireAccessRequests(db, now(), { userId: p.user.id });
    const rows = await requestRows(db, and(eq(accessRequests.userId, p.user.id), isNull(projects.deletedAt), q.status ? eq(accessRequests.status, q.status) : undefined));
    return { requests: rows.map(requestDto) };
  });

  const decideRequest = async (req: FastifyRequest<PR>, approve: boolean) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'member.manage');
    const body = approve ? parse(accessRequestApproveSchema, req.body) : {};
    const at = now();
    await db.transaction(async (tx) => {
      await lockProject(tx, project.id);
      await expireAccessRequests(tx, at, { projectId: project.id });
      const row = await loadRequest(tx, project.id, req.params.requestId);
      if (row.r.status !== 'open') throw new AppError(409, 'REQUEST_CLOSED', `this request is ${row.r.status}`);
      const asked = row.r.role as RequestableRole;
      let granted: ProjectRole | null = null;
      if (approve) {
        const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, row.r.userId));
        if (u?.status !== 'active') throw new AppError(409, 'CONFLICT', 'the requester account is not active');
        granted = (body as { role?: ProjectRole }).role ?? asked;
        const prev = await setMemberRole(tx, project.id, row.r.userId, granted, principal.user.id);
        void prev;
      }
      await tx
        .update(accessRequests)
        .set({ status: approve ? 'approved' : 'rejected', decidedAt: at, decidedBy: principal.user.id, grantedRole: granted })
        .where(eq(accessRequests.id, row.r.id));
      await record(tx, feed, actorOf(principal), {
        projectId: project.id,
        kind: approve ? 'access.approved' : 'access.rejected',
        summary: approve
          ? `권한 요청 승인: ${row.uName} → ${ROLE_LABEL[granted!]}${granted !== asked ? ` (요청: ${ROLE_LABEL[asked]})` : ''}`
          : `권한 요청 거절: ${row.uName} (${ROLE_LABEL[asked]})`,
        targetType: 'member',
        targetId: row.r.userId,
        details: { requestId: row.r.id, requestedRole: asked, ...(granted ? { role: granted } : {}) },
      });
      await insertUserEvents(tx, [
        {
          userId: row.r.userId,
          projectId: project.id,
          runId: null,
          kind: approve ? 'access.approved' : 'access.rejected',
          data: { projectName: project.name, requestId: row.r.id, role: asked, ...(granted ? { grantedRole: granted } : {}) },
          at,
        },
      ]);
    });
    return requestDto(await loadRequest(db, project.id, req.params.requestId));
  };
  app.post<PR>('/api/projects/:id/access-requests/:requestId/approve', (req) => decideRequest(req, true));
  app.post<PR>('/api/projects/:id/access-requests/:requestId/reject', (req) => decideRequest(req, false));

  // ── Leave · transfer ───────────────────────────────────────────────────────
  app.post<P>('/api/projects/:id/leave', async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'member.leave');
    await db.transaction(async (tx) => {
      await lockProject(tx, project.id);
      const prev = await removeMember(tx, project.id, principal.user.id);
      if (!prev) throw new AppError(409, 'NOT_MEMBER', 'you are not a member of this project');
      await record(tx, feed, actorOf(principal), {
        projectId: project.id,
        kind: 'member.left',
        summary: `구성원 나가기: ${principal.user.name} (${ROLE_LABEL[prev]})`,
        targetType: 'member',
        targetId: principal.user.id,
        details: { previousRole: prev },
      });
    });
    return reply.status(204).send();
  });

  app.post<P>('/api/projects/:id/transfer', async (req) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'project.transfer');
    const body = parse(transferSchema, req.body);
    if (body.userId === principal.user.id) throw new AppError(409, 'CONFLICT', 'choose someone else to transfer ownership to');
    const [target] = await db.select({ id: users.id, name: users.name, status: users.status }).from(users).where(eq(users.id, body.userId));
    if (!target) throw notFound('user');
    if (target.status !== 'active') throw new AppError(409, 'CONFLICT', 'only active members of the organization can become owners');
    await db.transaction(async (tx) => {
      await lockProject(tx, project.id);
      const targetPrev = await setMemberRole(tx, project.id, target.id, 'owner', principal.user.id);
      if (body.myRole === 'leave') await removeMember(tx, project.id, principal.user.id);
      else await setMemberRole(tx, project.id, principal.user.id, body.myRole, principal.user.id);
      await record(tx, feed, actorOf(principal), {
        projectId: project.id,
        kind: 'project.transferred',
        summary: `소유권 이전: ${principal.user.name} → ${target.name} (${body.myRole === 'leave' ? '나감' : `내 역할 ${ROLE_LABEL[body.myRole]}`})`,
        targetType: 'member',
        targetId: target.id,
        details: { from: principal.user.id, to: target.id, targetPreviousRole: targetPrev, myRole: body.myRole },
      });
    });
    const members = await db
      .select({ userId: projectMembers.userId, role: projectMembers.role, addedAt: projectMembers.addedAt, email: users.email, name: users.name, status: users.status })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(eq(projectMembers.projectId, project.id))
      .orderBy(asc(users.name));
    return {
      members: members.map((m): MemberDto => ({ userId: m.userId, email: m.email, name: m.name, role: m.role as MemberDto['role'], active: m.status === 'active', addedAt: m.addedAt.toISOString() })),
    };
  });

  // ── Merge gate (app "클라우드 프로젝트와 합치기", target fixed) ────────────────
  const mergeGate = async (req: FastifyRequest<P>) => {
    const access = await projectAccess(ctx, req, req.params.id, 'project.view');
    const body = parse(mergeSchema, req.body);
    if (!decide({ role: access.role, action: 'project.merge', tokenPermission: access.principal.tokenPermission })) {
      throw new AppError(403, 'FORBIDDEN', 'only an owner can merge a local project into this cloud project', { reason: 'not_owner' });
    }
    const rejection = mergeRejection(access.project, body);
    if (rejection) throw rejection;
    return { ...access, body };
  };

  app.post<P>('/api/projects/:id/merge/check', async (req) => {
    const { project, role, principal, isMember, creatorName } = await mergeGate(req);
    return { ok: true, origin: project.origin, project: projectDto(project, role, principal.tokenPermission, { can: canFor(role, isMember, principal.tokenPermission) }, { isMember, creatorName }) };
  });

  app.post<P>('/api/projects/:id/merge', async (req) => {
    const { project, role, principal, isMember, creatorName, body } = await mergeGate(req);
    const updated = await db.transaction(async (tx) => {
      await lockProject(tx, project.id);
      const [cur] = await tx.select().from(projects).where(eq(projects.id, project.id));
      // Re-check under the lock (a concurrent merge may have filled the birth record already).
      const again = mergeRejection(cur!, body);
      if (again) throw again;
      let row = cur!;
      if (cur!.origin === 'unknown') {
        const [u] = await tx.update(projects).set({ origin: 'app', originLocalId: body.localProjectId }).where(and(eq(projects.id, project.id), eq(projects.origin, 'unknown'))).returning();
        row = u!;
      }
      const s = body.summary ?? {};
      await record(tx, feed, actorOf(principal), {
        projectId: project.id,
        kind: 'project.merged',
        summary: `로컬 프로젝트 합치기 — 스크립트 올림 ${s.scriptsUploaded ?? 0} · 고름 ${s.scriptsChosen ?? 0} · 테스트 세트 ${s.suitesUploaded ?? 0} · 환경 ${s.environmentsUploaded ?? 0} · 옮긴 실행 ${s.runsMoved ?? 0}`,
        targetType: 'project',
        targetId: project.id,
        details: { localProjectId: body.localProjectId, birthFilled: cur!.origin === 'unknown', ...s },
      });
      return row;
    });
    return { ok: true, project: projectDto(updated, role, principal.tokenPermission, { can: canFor(role, isMember, principal.tokenPermission) }, { isMember, creatorName }) };
  });

  // ── Receive list (app [클라우드에서 받기]) ──────────────────────────────────
  app.get('/api/projects/receivable', async (req) => {
    const p = requirePrincipal(req);
    const mine = await db.select({ projectId: projectMembers.projectId, role: projectMembers.role }).from(projectMembers).where(eq(projectMembers.userId, p.user.id));
    const roles = new Map(mine.map((m) => [m.projectId, m.role as ProjectRole]));
    const rows = await db.select().from(projects).where(and(isNull(projects.deletedAt), visibleTo([...roles.keys()]))).orderBy(asc(projects.name));
    await expireAccessRequests(db, now(), { userId: p.user.id });
    const open = await db
      .select()
      .from(accessRequests)
      .where(and(eq(accessRequests.userId, p.user.id), eq(accessRequests.status, 'open')));
    const openBy = new Map(open.map((r) => [r.projectId, r]));
    const last = await lastRuns(db, rows.map((r) => r.id));
    const names = await creatorNames(db, rows);
    const out: { mine: ReceivableProjectDto[]; org: ReceivableProjectDto[] } = { mine: [], org: [] };
    for (const r of rows) {
      const myRole = roles.get(r.id) ?? 'viewer';
      const req0 = openBy.get(r.id);
      const item: ReceivableProjectDto = {
        id: r.id,
        name: r.name,
        description: r.description,
        createdBy: r.createdBy ? { id: r.createdBy, name: names.get(r.createdBy) ?? '' } : null,
        origin: r.origin as ReceivableProjectDto['origin'],
        originLocalId: r.originLocalId,
        visibility: r.visibility as ReceivableProjectDto['visibility'],
        myRole,
        lastRun: last.get(r.id) ?? null,
        canRequestAccess: !req0 && p.tokenPermission !== 'read' && canFor(myRole, roles.has(r.id)).includes('access.request'),
        openRequest: req0 ? { id: req0.id, role: req0.role as RequestableRole, createdAt: req0.createdAt.toISOString(), expiresAt: req0.expiresAt.toISOString() } : null,
      };
      (roles.has(r.id) ? out.mine : out.org).push(item);
    }
    return out;
  });

  // ── Admin: projects whose owners are all deactivated ───────────────────────
  const ownerless = async (onlyId?: string): Promise<OwnerlessProjectDto[]> => {
    const rows = await db
      .select({ id: projects.id, name: projects.name, visibility: projects.visibility, createdAt: projects.createdAt })
      .from(projects)
      .where(
        and(
          isNull(projects.deletedAt),
          onlyId ? eq(projects.id, onlyId) : undefined,
          sql`not exists (select 1 from project_members m join users u on u.id = m.user_id where m.project_id = ${projects.id} and m.role = 'owner' and u.status = 'active')`,
        ),
      )
      .orderBy(asc(projects.name));
    if (!rows.length) return [];
    const ms = await db
      .select({ projectId: projectMembers.projectId, role: projectMembers.role, id: users.id, name: users.name, email: users.email, status: users.status })
      .from(projectMembers)
      .innerJoin(users, eq(users.id, projectMembers.userId))
      .where(inArray(projectMembers.projectId, rows.map((r) => r.id)))
      .orderBy(asc(users.name));
    return rows.map((r) => {
      const of = ms.filter((m) => m.projectId === r.id);
      return {
        id: r.id,
        name: r.name,
        visibility: r.visibility as OwnerlessProjectDto['visibility'],
        createdAt: r.createdAt.toISOString(),
        owners: of.filter((m) => m.role === 'owner').map((m) => ({ id: m.id, name: m.name, email: m.email, status: m.status })),
        members: of.filter((m) => m.role !== 'owner' && m.status === 'active').map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role as ProjectRole })),
      };
    });
  };

  app.get('/api/admin/projects/ownerless', async (req) => {
    requireAdmin(req);
    return { projects: await ownerless() };
  });

  app.post<P>('/api/admin/projects/:id/owner', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(adminAssignOwnerSchema, req.body);
    const [proj] = await ownerless(req.params.id);
    // Only for ownerless projects: admins get no other project privileges.
    if (!proj) {
      const [exists] = await db.select({ id: projects.id }).from(projects).where(and(eq(projects.id, req.params.id), isNull(projects.deletedAt)));
      if (!exists) throw notFound('project');
      throw forbidden('this project still has an active owner — administrators can only assign owners to ownerless projects');
    }
    const [target] = await db.select({ id: users.id, name: users.name, status: users.status }).from(users).where(eq(users.id, body.userId));
    if (!target) throw notFound('user');
    if (target.status !== 'active') throw new AppError(409, 'CONFLICT', 'only active members of the organization can become owners');
    await db.transaction(async (tx) => {
      await lockProject(tx, proj.id);
      const prev = await currentRole(tx, proj.id, target.id);
      await setMemberRole(tx, proj.id, target.id, 'owner', admin.user.id);
      await record(tx, feed, adminActor(admin), {
        projectId: proj.id,
        kind: 'project.owner_assigned',
        summary: `관리자 소유자 지정: ${target.name}`,
        targetType: 'member',
        targetId: target.id,
        details: { role: 'owner', ...(prev ? { previousRole: prev } : {}) },
      });
    });
    return { projects: await ownerless() };
  });
}
