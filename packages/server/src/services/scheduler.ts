// Schedules (SPEC 예약, ADR-020 §3): an in-server 1-minute tick. One server instance at a time does
// the tick (`pg_try_advisory_lock`), and every due schedule is handled in its own transaction under
// a row lock that re-checks `next_run_at` — so an occurrence is registered exactly once even if two
// instances tick together. Never catches up: missed occurrences leave one `skipped(missed)` record.
import type { RunSource } from '@euta-cloud/shared';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Tx } from '../db/index.js';
import { environments, projects, runs, schedules } from '../db/schema.js';
import type { ProjectRow } from './access.js';
import { record } from './activity.js';
import { nextOccurrence, prevOccurrence } from './cron.js';
import { insertUserEvents, type UserEventInsert } from './user-events.js';
import { capRoom } from './daily-cap.js';
import { onTopLevelTerminal, scheduleActor } from './outcomes.js';
import { insertPlannedRun, planRun, planScriptCount } from './runs.js';

export type ScheduleRow = typeof schedules.$inferSelect;

export const SCHEDULER_TICK_MS = 60_000;
/**
 * How late an occurrence may still start. Beyond this the server was not ticking (stopped, or
 * restarted slowly) and the occurrence counts as missed.
 */
export const SCHEDULE_MISSED_GRACE_MS = 5 * 60_000;

export interface TickResult {
  locked: boolean;
  fired: number;
  skipped: { overlap: number; missed: number; 'daily-cap': number };
  errors: number;
}

/** One scheduler pass. Returns `locked: false` when another instance holds the tick lock. */
export async function tickSchedules(ctx: AppContext): Promise<TickResult> {
  const out: TickResult = { locked: false, fired: 0, skipped: { overlap: 0, missed: 0, 'daily-cap': 0 }, errors: 0 };
  const client = await ctx.pool.connect();
  try {
    const got = await client.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext('euta_scheduler')) as ok`);
    if (!got.rows[0]?.ok) return out;
    out.locked = true;
    try {
      const now = ctx.clock.now();
      const due = await ctx.db
        .select({ id: schedules.id })
        .from(schedules)
        .innerJoin(projects, eq(projects.id, schedules.projectId))
        .where(and(eq(schedules.enabled, true), isNull(projects.deletedAt), lte(schedules.nextRunAt, now)));
      for (const { id } of due) {
        try {
          const results = await ctx.db.transaction((tx) => fireSchedule(ctx, tx, id));
          for (const r of results) {
            if (r === 'fired' || r === 'error') out.fired++;
            if (r === 'error') out.errors++;
            if (r === 'overlap' || r === 'missed' || r === 'daily-cap') out.skipped[r]++;
          }
        } catch (err) {
          out.errors++;
          ctx.log.error({ err: { message: (err as Error).message }, scheduleId: id }, 'schedule tick failed');
        }
      }
    } finally {
      await client.query(`select pg_advisory_unlock(hashtext('euta_scheduler'))`);
    }
  } finally {
    client.release();
  }
  return out;
}

type FireResult = 'fired' | 'error' | 'overlap' | 'missed' | 'daily-cap' | 'none';

async function fireSchedule(ctx: AppContext, tx: Tx, id: string): Promise<FireResult[]> {
  // App notification events are written last (they hold the user-events lock until commit).
  const events: UserEventInsert[] = [];
  const results: FireResult[] = [];
  results.push(await fireScheduleIn(ctx, tx, id, events, results));
  await insertUserEvents(tx, events);
  return results;
}

async function fireScheduleIn(ctx: AppContext, tx: Tx, id: string, events: UserEventInsert[], results: FireResult[]): Promise<FireResult> {
  const now = ctx.clock.now();
  const [s] = await tx.select().from(schedules).where(eq(schedules.id, id)).for('update');
  if (!s || !s.enabled || !s.nextRunAt || s.nextRunAt > now) return 'none';
  const [project] = await tx.select().from(projects).where(eq(projects.id, s.projectId));
  if (!project || project.deletedAt) return 'none';
  const occurrence = s.nextRunAt;
  // The latest occurrence that is due; earlier ones (if any) were missed.
  const prev = prevOccurrence(s.cron, new Date(now.getTime() + 1));
  const latest = prev > occurrence ? prev : occurrence;
  const next = nextOccurrence(s.cron, now);
  await tx.update(schedules).set({ nextRunAt: next, lastFiredAt: now }).where(eq(schedules.id, s.id));
  const late = now.getTime() - latest.getTime() > SCHEDULE_MISSED_GRACE_MS;
  if (late || latest > occurrence) {
    // Missed occurrence(s): one record, never a burst of catch-up runs.
    await skippedRun(ctx, tx, s, project, occurrence, 'missed', events);
    if (late) return 'missed';
    results.push('missed');
  }
  const active = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.scheduleId, s.id), isNull(runs.parentRunId), inArray(runs.status, ['queued', 'leased', 'running'])))
    .limit(1);
  if (active.length) {
    await skippedRun(ctx, tx, s, project, latest, 'overlap', events);
    return 'overlap';
  }
  const body = {
    ...(s.kind === 'suite' ? { suiteId: s.suiteId ?? '__deleted__' } : { scriptId: s.scriptId ?? '__deleted__' }),
    ...(s.environmentId ? { environmentId: s.environmentId } : {}),
  };
  let plan: Awaited<ReturnType<typeof planRun>> | null = null;
  let problem: string | null = null;
  if (!s.environmentId) {
    // Never fall back to another environment (default) — the schedule names one; it was deleted.
    problem = "the schedule's environment was deleted";
  } else {
    try {
      plan = await planRun(ctx, project, body);
      if (plan.problems.length) problem = plan.problems.map((p) => `${p.code}: ${p.message}${p.script ? ` (${p.script})` : ''}`).join('; ');
    } catch (e) {
      problem = `${(e as Error).message}`;
    }
  }
  if (problem || !plan) {
    await precheckErrorRun(ctx, tx, s, project, latest, problem ?? 'precheck failed', events);
    return 'error';
  }
  const room = await capRoom(tx, project.id, project.dailyRunCap, now, planScriptCount(plan));
  if (!room.ok) {
    await skippedRun(ctx, tx, s, project, latest, 'daily-cap', events);
    return 'daily-cap';
  }
  await insertPlannedRun(ctx, tx, project, plan, {
    actor: scheduleActor(s),
    requestedBy: s.createdBy,
    source: 'schedule',
    vars: {},
    timeLimitSec: s.timeLimitSec ?? project.runTimeLimitSec,
    scheduleId: s.id,
    scheduledFor: latest,
  });
  return 'fired';
}

async function placeholderRow(tx: Tx, s: ScheduleRow, project: ProjectRow, occurrence: Date, now: Date) {
  const [env] = s.environmentId ? await tx.select({ name: environments.name }).from(environments).where(eq(environments.id, s.environmentId)) : [];
  const [target] =
    s.kind === 'suite'
      ? await tx.execute<{ name: string }>(sql`select name from suites where id = ${s.suiteId ?? ''}`).then((r) => r.rows)
      : await tx.execute<{ name: string }>(sql`select path as name from scripts where id = ${s.scriptId ?? ''}`).then((r) => r.rows);
  const actor = scheduleActor(s);
  return {
    projectId: project.id,
    kind: s.kind,
    ...(s.kind === 'suite' ? { suiteId: s.suiteId, suiteName: target?.name ?? null } : { scriptId: s.scriptId, scriptPath: target?.name ?? null }),
    environmentId: s.environmentId,
    environmentName: env?.name ?? '(삭제된 환경)',
    source: 'schedule' satisfies RunSource,
    requestedBy: s.createdBy,
    requestedByLabel: actor.label,
    actorType: actor.type,
    timeLimitSec: s.timeLimitSec ?? project.runTimeLimitSec,
    record: { video: 'on-failure' as const, trace: 'on-failure' as const },
    scheduleId: s.id,
    scheduledFor: occurrence,
    createdAt: now,
    finishedAt: now,
  };
}

const SKIP_KO = { overlap: '겹침 — 이전 회차가 아직 실행 중', missed: '놓침 — 서버가 회차 시각에 동작하지 않음', 'daily-cap': '일일 실행 상한 도달' } as const;

async function skippedRun(ctx: AppContext, tx: Tx, s: ScheduleRow, project: ProjectRow, occurrence: Date, reason: keyof typeof SKIP_KO, events: UserEventInsert[]): Promise<void> {
  const now = ctx.clock.now();
  const [row] = await tx
    .insert(runs)
    .values({ ...(await placeholderRow(tx, s, project, occurrence, now)), status: 'skipped', skipReason: reason, error: SKIP_KO[reason] })
    .returning();
  await record(tx, ctx.feed, scheduleActor(s), {
    projectId: project.id,
    kind: 'run.skipped',
    summary: `예약 건너뜀: ${s.name} (${SKIP_KO[reason]})`,
    targetType: 'run',
    targetId: row!.id,
    details: { scheduleId: s.id, reason, scheduledFor: occurrence.toISOString() },
    feedData: { runId: row!.id, status: 'skipped', skipReason: reason, scheduleId: s.id },
  });
  await onTopLevelTerminal(ctx, tx, row!, events);
}

/** The occurrence could not be queued (script/environment deleted, precheck failed): an `error` run says why. */
async function precheckErrorRun(ctx: AppContext, tx: Tx, s: ScheduleRow, project: ProjectRow, occurrence: Date, problem: string, events: UserEventInsert[]): Promise<void> {
  const now = ctx.clock.now();
  const [row] = await tx
    .insert(runs)
    .values({ ...(await placeholderRow(tx, s, project, occurrence, now)), status: 'error', error: `precheck failed: ${problem}`.slice(0, 2000) })
    .returning();
  await record(tx, ctx.feed, scheduleActor(s), {
    projectId: project.id,
    kind: 'run.finished',
    summary: `예약 실행 불가: ${s.name} — ${problem.slice(0, 200)}`,
    targetType: 'run',
    targetId: row!.id,
    details: { scheduleId: s.id, status: 'error', error: problem.slice(0, 300) },
    feedData: { runId: row!.id, status: 'error', scheduleId: s.id },
  });
  await onTopLevelTerminal(ctx, tx, row!, events);
}
