// Schedules API (SPEC 예약 · API 개요): GET/POST /api/projects/:id/schedules · GET/PATCH/DELETE …/:scheduleId.
// Reading = everyone who can view the project; changes = editor+ (`schedule.manage`).
import { cadenceToCron, SCHEDULE_TIMEZONE, scheduleCreateSchema, scheduleUpdateSchema, type Cadence, type ScheduleDto } from '@euta-cloud/shared';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { environments, runs, schedules, scripts, scriptVersions, suites } from '../db/schema.js';
import { AppError, notFound, parse } from '../http.js';
import { actorOf, projectAccess, type ProjectRow } from '../services/access.js';
import { record } from '../services/activity.js';
import { analyzeCron, CronError, nextOccurrence } from '../services/cron.js';
import type { ScheduleRow } from '../services/scheduler.js';
import { scriptNameOf } from '../services/script-name.js';

type P = { Params: { id: string } };
type SP = { Params: { id: string; scheduleId: string } };

const invalid = (path: string, message: string) => new AppError(422, 'VALIDATION_FAILED', message, [{ path, message }]);

function cronOf(cadence: Cadence): { cron: string; intervalSec: number } {
  const cron = cadenceToCron(cadence);
  try {
    return { cron, intervalSec: analyzeCron(cron).intervalMin * 60 };
  } catch (e) {
    if (e instanceof CronError) throw invalid('cadence', e.message);
    throw e;
  }
}

async function checkTarget(db: DbOrTx, projectId: string, t: { scriptId?: string; suiteId?: string }): Promise<void> {
  if (t.scriptId) {
    const [s] = await db.select({ id: scripts.id }).from(scripts).where(and(eq(scripts.id, t.scriptId), eq(scripts.projectId, projectId), isNull(scripts.deletedAt)));
    if (!s) throw invalid('scriptId', 'unknown script');
  }
  if (t.suiteId) {
    const [s] = await db.select({ id: suites.id }).from(suites).where(and(eq(suites.id, t.suiteId), eq(suites.projectId, projectId)));
    if (!s) throw invalid('suiteId', 'unknown suite');
  }
}

async function checkEnvironment(db: DbOrTx, projectId: string, environmentId: string): Promise<void> {
  const [e] = await db.select({ id: environments.id }).from(environments).where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)));
  if (!e) throw invalid('environmentId', 'unknown environment');
}

/** Environment default: suite default → project default (stored on the schedule). */
async function defaultEnvironment(db: DbOrTx, project: ProjectRow, suiteId?: string | null): Promise<string> {
  if (suiteId) {
    const [s] = await db.select({ env: suites.defaultEnvironmentId }).from(suites).where(eq(suites.id, suiteId));
    if (s?.env) return s.env;
  }
  if (project.defaultEnvironmentId) return project.defaultEnvironmentId;
  throw invalid('environmentId', 'choose an environment (the project has no default environment)');
}

const TERMINAL_RUN = ['passed', 'failed', 'error', 'timeout'];

export async function scheduleDtos(ctx: AppContext, rows: ScheduleRow[]): Promise<ScheduleDto[]> {
  if (!rows.length) return [];
  const { db } = ctx;
  const scriptIds = rows.map((r) => r.scriptId).filter((v): v is string => !!v);
  const suiteIds = rows.map((r) => r.suiteId).filter((v): v is string => !!v);
  const envIds = rows.map((r) => r.environmentId).filter((v): v is string => !!v);
  const scriptRows = scriptIds.length
    ? await db
        .select({ id: scripts.id, path: scripts.path, source: scriptVersions.source, contentHash: scriptVersions.contentHash })
        .from(scripts)
        .leftJoin(scriptVersions, and(eq(scriptVersions.scriptId, scripts.id), eq(scriptVersions.version, scripts.currentVersion)))
        .where(inArray(scripts.id, scriptIds))
    : [];
  const suiteRows = suiteIds.length ? await db.select({ id: suites.id, name: suites.name }).from(suites).where(inArray(suites.id, suiteIds)) : [];
  const envRows = envIds.length ? await db.select({ id: environments.id, name: environments.name }).from(environments).where(inArray(environments.id, envIds)) : [];
  const pathOf = new Map(scriptRows.map((s) => [s.id, s.path]));
  const nameOf = new Map(scriptRows.map((s) => [s.id, scriptNameOf(s.source, s.contentHash)]));
  const suiteOf = new Map(suiteRows.map((s) => [s.id, s.name]));
  const envOf = new Map(envRows.map((e) => [e.id, e.name]));
  const out: ScheduleDto[] = [];
  for (const s of rows) {
    const recent = await db
      .select({ id: runs.id, status: runs.status, flaky: runs.flaky, skipReason: runs.skipReason, finishedAt: runs.finishedAt, durationMs: runs.durationMs, startedAt: runs.startedAt })
      .from(runs)
      .where(and(eq(runs.scheduleId, s.id), isNull(runs.parentRunId)))
      .orderBy(desc(runs.createdAt))
      .limit(10);
    const last = recent[0];
    const durations = recent
      .filter((r) => TERMINAL_RUN.includes(r.status))
      .map((r) => r.durationMs ?? (r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null))
      .filter((d): d is number => d !== null)
      .slice(0, 3);
    const avg = durations.length === 3 ? durations.reduce((a, b) => a + b, 0) / 3 : null;
    const intervalMs = s.intervalSec * 1000;
    out.push({
      id: s.id,
      name: s.name,
      target:
        s.kind === 'suite'
          ? { kind: 'suite', suite: { id: s.suiteId, name: s.suiteId ? (suiteOf.get(s.suiteId) ?? null) : null } }
          : { kind: 'script', script: { id: s.scriptId, path: s.scriptId ? (pathOf.get(s.scriptId) ?? null) : null, name: s.scriptId ? (nameOf.get(s.scriptId) ?? null) : null } },
      environment: { id: s.environmentId, name: s.environmentId ? (envOf.get(s.environmentId) ?? null) : null },
      cadence: s.cadence as Cadence,
      cron: s.cron,
      timezone: s.timezone,
      timeLimitSec: s.timeLimitSec,
      retryOnFailure: s.retryOnFailure,
      enabled: s.enabled,
      disabledReason: s.disabledReason,
      nextRunAt: s.enabled && s.nextRunAt ? s.nextRunAt.toISOString() : null,
      intervalMin: Math.round(s.intervalSec / 60),
      createdBy: { id: s.createdBy, label: s.createdByLabel },
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      lastRun: last ? { id: last.id, status: last.status, flaky: last.flaky, skipReason: last.skipReason, finishedAt: last.finishedAt?.toISOString() ?? null } : null,
      durationWarning: avg !== null && avg > intervalMs ? { avgDurationMs: Math.round(avg), intervalMs } : null,
    });
  }
  return out;
}

async function loadSchedule(db: DbOrTx, projectId: string, scheduleId: string): Promise<ScheduleRow> {
  const [s] = await db.select().from(schedules).where(and(eq(schedules.id, scheduleId), eq(schedules.projectId, projectId)));
  if (!s) throw notFound('schedule');
  return s;
}

export async function scheduleRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, feed } = ctx;
  const base = '/api/projects/:id/schedules';

  app.get<P>(base, async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const rows = await db.select().from(schedules).where(eq(schedules.projectId, project.id)).orderBy(asc(schedules.name), asc(schedules.createdAt));
    return { schedules: await scheduleDtos(ctx, rows) };
  });

  app.get<SP>(`${base}/:scheduleId`, async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    return (await scheduleDtos(ctx, [await loadSchedule(db, project.id, req.params.scheduleId)]))[0]!;
  });

  app.post<P>(base, async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'schedule.manage');
    const body = parse(scheduleCreateSchema, req.body);
    await checkTarget(db, project.id, body);
    const environmentId = body.environmentId ?? (await defaultEnvironment(db, project, body.suiteId));
    await checkEnvironment(db, project.id, environmentId);
    const { cron, intervalSec } = cronOf(body.cadence);
    const now = ctx.clock.now();
    const enabled = body.enabled ?? true;
    const actor = actorOf(principal);
    const row = await db.transaction(async (tx) => {
      const [s] = await tx
        .insert(schedules)
        .values({
          projectId: project.id,
          name: body.name,
          kind: body.suiteId ? 'suite' : 'script',
          scriptId: body.scriptId ?? null,
          suiteId: body.suiteId ?? null,
          environmentId,
          cadence: body.cadence,
          cron,
          timezone: SCHEDULE_TIMEZONE,
          intervalSec,
          timeLimitSec: body.timeLimitSec ?? null,
          retryOnFailure: body.retryOnFailure ?? false,
          enabled,
          nextRunAt: enabled ? nextOccurrence(cron, now) : null,
          createdBy: principal.user.id,
          createdByLabel: principal.user.name,
          createdAt: now,
          updatedAt: now,
          updatedBy: principal.user.id,
        })
        .returning();
      await record(tx, feed, actor, {
        projectId: project.id,
        kind: 'schedule.created',
        summary: `예약 만들기: ${body.name} (${cron})`,
        targetType: 'schedule',
        targetId: s!.id,
        details: { cron, enabled },
      });
      return s!;
    });
    reply.status(201);
    return (await scheduleDtos(ctx, [row]))[0]!;
  });

  app.patch<SP>(`${base}/:scheduleId`, async (req) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'schedule.manage');
    const body = parse(scheduleUpdateSchema, req.body);
    const cur = await loadSchedule(db, project.id, req.params.scheduleId);
    await checkTarget(db, project.id, body);
    if (body.environmentId) await checkEnvironment(db, project.id, body.environmentId);
    const now = ctx.clock.now();
    const changes: Partial<typeof schedules.$inferInsert> = { updatedAt: now, updatedBy: principal.user.id };
    if (body.name !== undefined) changes.name = body.name;
    if (body.scriptId !== undefined) Object.assign(changes, { kind: 'script', scriptId: body.scriptId, suiteId: null });
    if (body.suiteId !== undefined) Object.assign(changes, { kind: 'suite', suiteId: body.suiteId, scriptId: null });
    if (body.environmentId !== undefined) changes.environmentId = body.environmentId;
    if (body.timeLimitSec !== undefined) changes.timeLimitSec = body.timeLimitSec;
    if (body.retryOnFailure !== undefined) changes.retryOnFailure = body.retryOnFailure;
    let cron = cur.cron;
    if (body.cadence !== undefined) {
      const c = cronOf(body.cadence);
      cron = c.cron;
      Object.assign(changes, { cadence: body.cadence, cron: c.cron, intervalSec: c.intervalSec });
    }
    const enabled = body.enabled ?? cur.enabled;
    if (body.enabled !== undefined) {
      changes.enabled = body.enabled;
      if (body.enabled) changes.disabledReason = null;
    }
    // Re-plan from now when (re-)enabled or the cadence changed — a disabled period is never "missed".
    if (!enabled) changes.nextRunAt = null;
    else if (body.cadence !== undefined || (body.enabled && !cur.enabled) || !cur.nextRunAt) changes.nextRunAt = nextOccurrence(cron, now);
    const row = await db.transaction(async (tx) => {
      const [s] = await tx.update(schedules).set(changes).where(eq(schedules.id, cur.id)).returning();
      const fields = Object.keys(body);
      await record(tx, feed, actorOf(principal), {
        projectId: project.id,
        kind: 'schedule.updated',
        summary: `예약 변경: ${s!.name} (${fields.join(', ') || '없음'})`,
        targetType: 'schedule',
        targetId: s!.id,
        details: { fields },
      });
      return s!;
    });
    return (await scheduleDtos(ctx, [row]))[0]!;
  });

  app.delete<SP>(`${base}/:scheduleId`, async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'schedule.manage');
    const cur = await loadSchedule(db, project.id, req.params.scheduleId);
    await db.transaction(async (tx) => {
      await tx.delete(schedules).where(eq(schedules.id, cur.id));
      await record(tx, feed, actorOf(principal), { projectId: project.id, kind: 'schedule.deleted', summary: `예약 삭제: ${cur.name}`, targetType: 'schedule', targetId: cur.id });
    });
    return reply.status(204).send();
  });
}

/** Trash turns every schedule of the project off (SPEC 예약 "상태"); restoring does not turn them back on. */
export async function disableProjectSchedules(tx: DbOrTx, projectId: string, now: Date): Promise<number> {
  const res = await tx
    .update(schedules)
    .set({ enabled: false, disabledReason: 'project_trashed', nextRunAt: null, updatedAt: now })
    .where(and(eq(schedules.projectId, projectId), eq(schedules.enabled, true)));
  return res.rowCount ?? 0;
}
