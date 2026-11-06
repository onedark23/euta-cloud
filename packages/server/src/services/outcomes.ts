// What happens when a top-level run ends (C3, SPEC 실행 상태 · 알림): retry once for a failed
// scheduled run, "passed · flaky" when the retry passes, the Teams notification decision
// (failure-class · recovery · consecutive suppression · toggles) and app notification events.
// Runs inside the terminal transaction; HTTP happens later (notify.ts outbox).
import { describeStep, stepText } from '@euta/core/describe';
import { parseYaml } from '@euta/core';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Tx } from '../db/index.js';
import { projectMembers, projects, runs, schedules } from '../db/schema.js';
import type { Actor } from './access.js';
import { record } from './activity.js';
import { capRoom } from './daily-cap.js';
import { buildTeamsMessage, enqueueNotification, NOTIFY_CHANNEL, type NotificationKind } from './notify.js';
import { insertUserEvents, type UserEventInsert } from './user-events.js';

type RunRow = typeof runs.$inferSelect;

export const FAILURE_STATUSES = new Set(['failed', 'error', 'timeout']);
const CHAIN_STATUSES = ['passed', 'failed', 'error', 'timeout'];

export const scheduleActor = (s: { createdBy: string | null; createdByLabel: string }): Actor => ({
  type: 'schedule',
  id: s.createdBy,
  label: `예약 — ${s.createdByLabel}`,
});

/** Web run page (C4 web UI route). */
export const runUrl = (ctx: AppContext, projectId: string, runId: string) => `${ctx.config.baseUrl}/projects/${projectId}/runs/${runId}`;

export const targetLabel = (r: Pick<RunRow, 'kind' | 'suiteName' | 'scriptPath' | 'id'>) =>
  r.kind === 'suite' ? `테스트 세트 ${r.suiteName ?? ''}`.trim() : (r.scriptPath ?? r.id);

/** Step sentence of the first failed/error step ("4.2" → steps[3].group.steps[1]). */
function stepSentence(source: string | null, stepId: string): string | null {
  if (!source) return null;
  try {
    const doc = parseYaml(source).value as { steps?: unknown[] } | null;
    let list: unknown[] | undefined = doc?.steps;
    let node: unknown;
    for (const part of stepId.split('.')) {
      const idx = Number(part) - 1;
      if (!list || !Number.isInteger(idx) || idx < 0 || idx >= list.length) return null;
      node = list[idx];
      const g = (node as { group?: { steps?: unknown[] } }).group;
      list = g?.steps;
    }
    return node === undefined ? null : stepText(describeStep(node));
  } catch {
    return null;
  }
}

function failedStepOf(r: RunRow): string | null {
  const step = (r.steps as { stepId?: string; status?: string; action?: string; name?: string }[]).find((s) => s.status === 'failed' || s.status === 'error');
  if (!step?.stepId) return null;
  return `${step.stepId}. ${stepSentence(r.scriptSource, step.stepId) ?? `${step.name ? `${step.name}: ` : ''}${step.action ?? ''}`}`;
}

async function failedStep(tx: Tx, r: RunRow): Promise<string | null> {
  if (r.kind === 'script') return failedStepOf(r);
  const kids = await tx.select().from(runs).where(eq(runs.parentRunId, r.id)).orderBy(asc(runs.orderIndex));
  const k = kids.find((c) => FAILURE_STATUSES.has(c.status));
  if (!k) return null;
  const s = failedStepOf(k);
  return `${k.scriptPath ?? ''}${s ? ` — ${s}` : ` (${k.status})`}`;
}

/** Previous scheduled outcome of the same (target, environment), skipping retried attempts. */
async function previousFailing(tx: Tx, r: RunRow): Promise<boolean> {
  const target = r.kind === 'suite' ? eq(runs.suiteId, r.suiteId ?? '') : r.scriptId ? eq(runs.scriptId, r.scriptId) : eq(runs.scriptPath, r.scriptPath ?? '');
  const [prev] = await tx
    .select({ status: runs.status })
    .from(runs)
    .where(
      and(
        eq(runs.projectId, r.projectId),
        eq(runs.source, 'schedule'),
        isNull(runs.parentRunId),
        eq(runs.kind, r.kind),
        ne(runs.id, r.id),
        target,
        r.environmentId ? eq(runs.environmentId, r.environmentId) : isNull(runs.environmentId),
        inArray(runs.status, CHAIN_STATUSES),
        sql`not exists (select 1 from runs c where c.retry_of_run_id = ${runs.id})`,
      ),
    )
    .orderBy(desc(runs.finishedAt), desc(runs.createdAt))
    .limit(1);
  return !!prev && FAILURE_STATUSES.has(prev.status);
}

/** Notification kind for a scheduled outcome, or null (suppressed / not wanted). */
export async function decideNotification(tx: Tx, r: RunRow, notify: { skipped: boolean; aborted: boolean; passed: boolean; flaky: boolean }): Promise<NotificationKind | null> {
  if (FAILURE_STATUSES.has(r.status)) return (await previousFailing(tx, r)) ? null : 'failure';
  if (r.status === 'passed') {
    if (await previousFailing(tx, r)) return 'recovery';
    if (r.flaky) return notify.flaky ? 'flaky' : null;
    return notify.passed ? 'passed' : null;
  }
  if (r.status === 'skipped') return notify.skipped ? 'skipped' : null;
  if (r.status === 'aborted') return notify.aborted ? 'aborted' : null;
  return null;
}

/** Copy a finished top-level run (with suite children) as a queued retry. Returns the new id. */
async function enqueueRetry(ctx: AppContext, tx: Tx, r: RunRow, actor: Actor): Promise<string | null> {
  const kids = r.kind === 'suite' ? await tx.select().from(runs).where(eq(runs.parentRunId, r.id)).orderBy(asc(runs.orderIndex)) : [];
  // Fire-time precheck errors never ran (no pinned text / no children): nothing to retry.
  if (r.kind === 'script' ? !r.scriptSource : !kids.length) return null;
  const [project] = await tx.select().from(projects).where(eq(projects.id, r.projectId));
  if (!project || project.deletedAt) return null;
  const room = await capRoom(tx, r.projectId, project.dailyRunCap, ctx.clock.now(), r.kind === 'suite' ? kids.length : 1);
  if (!room.ok) return null;
  const now = ctx.clock.now();
  const copy = (x: RunRow) => ({
    projectId: x.projectId,
    kind: x.kind,
    alwaysRun: x.alwaysRun,
    suiteId: x.suiteId,
    suiteName: x.suiteName,
    scriptId: x.scriptId,
    scriptPath: x.scriptPath,
    scriptVersion: x.scriptVersion,
    contentHash: x.contentHash,
    scriptSource: x.scriptSource,
    environmentId: x.environmentId,
    environmentName: x.environmentName,
    vars: x.vars,
    source: x.source,
    requestedBy: x.requestedBy,
    requestedByLabel: x.requestedByLabel,
    actorType: x.actorType,
    credentialNames: x.credentialNames,
    timeLimitSec: x.timeLimitSec,
    record: x.record,
    browser: x.browser,
    device: x.device,
    scheduleId: x.scheduleId,
    scheduledFor: x.scheduledFor,
    attempt: 2,
    status: 'queued',
    createdAt: now,
  });
  const [top] = await tx
    .insert(runs)
    .values({ ...copy(r), retryOfRunId: r.id })
    .onConflictDoNothing()
    .returning({ id: runs.id });
  if (!top) return null;
  if (kids.length) await tx.insert(runs).values(kids.map((k) => ({ ...copy(k), parentRunId: top.id, orderIndex: k.orderIndex })));
  await record(tx, ctx.feed, actor, {
    projectId: r.projectId,
    kind: 'run.requested',
    summary: `재실행 요청: ${targetLabel(r)} @ ${r.environmentName} (이전 시도 ${r.status})`,
    targetType: 'run',
    targetId: top.id,
    details: { source: r.source, environment: r.environmentName, retryOfRunId: r.id, ...(r.scheduleId ? { scheduleId: r.scheduleId } : {}) },
    feedData: { runId: top.id, status: 'queued', source: r.source, retryOfRunId: r.id },
  });
  await ctx.feed.notifyRuns(tx);
  return top.id;
}

/**
 * Called from `afterTerminal` (and for skipped records) inside the terminal transaction of a
 * top-level run. Writes user events last (they take the user-events lock until commit) — or hands
 * them to `sink` when the caller still has writes to do in this transaction.
 */
export async function onTopLevelTerminal(ctx: AppContext, tx: Tx, run: RunRow, sink?: UserEventInsert[]): Promise<void> {
  if (run.source === 'local_upload') return;
  let r = run;
  const events: UserEventInsert[] = [];
  const [project] = await tx.select().from(projects).where(eq(projects.id, r.projectId));
  if (!project) return;
  const now = ctx.clock.now();
  const base = async () => ({
    projectName: project.name,
    target: targetLabel(r),
    environment: r.environmentName,
    status: r.status,
    flaky: r.flaky,
    source: r.source,
    durationMs: r.durationMs ?? (r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null),
    url: runUrl(ctx, r.projectId, r.id),
    ...(FAILURE_STATUSES.has(r.status) ? { failedStep: await failedStep(tx, r) } : {}),
  });

  if (r.source === 'schedule') {
    const [sched] = r.scheduleId ? await tx.select().from(schedules).where(eq(schedules.id, r.scheduleId)) : [];
    if (r.attempt === 1 && FAILURE_STATUSES.has(r.status) && sched?.retryOnFailure) {
      // The retry's outcome decides the notification (no failure-then-recovery pair).
      if (await enqueueRetry(ctx, tx, r, scheduleActor(sched))) return;
    }
    if (r.attempt > 1 && r.status === 'passed' && !r.flaky) {
      const [u] = await tx.update(runs).set({ flaky: true }).where(eq(runs.id, r.id)).returning();
      r = u!;
      await ctx.feed.append(tx, r.projectId, 'run.flaky', null, { runId: r.id, retryOfRunId: r.retryOfRunId });
    }
    const kind = await decideNotification(tx, r, project.notifySettings);
    if (kind) {
      const data = { ...(await base()), ...(sched ? { scheduleName: sched.name } : {}), ...(r.skipReason ? { skipReason: r.skipReason } : {}) };
      if (project.teamsWebhookUrl) {
        const payload = buildTeamsMessage({ kind, ...data, skipReason: r.skipReason, scheduleName: sched?.name ?? null, failedStep: data.failedStep ?? null, attempt: r.attempt });
        await enqueueNotification(tx, { projectId: r.projectId, runId: r.id, kind, payload, at: now });
        await tx.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, '')`);
      }
      const members = await tx.select({ userId: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, r.projectId));
      for (const m of members) events.push({ userId: m.userId, projectId: r.projectId, runId: r.id, kind, data, at: now });
    }
  } else if (r.requestedBy && r.status !== 'skipped') {
    // A person's (or their token's) own cloud run: app notification to the requester only — never Teams.
    events.push({ userId: r.requestedBy, projectId: r.projectId, runId: r.id, kind: 'run.finished', data: await base(), at: now });
  }
  if (sink) sink.push(...events);
  else await insertUserEvents(tx, events);
}
