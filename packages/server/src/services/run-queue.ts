// Runner side of the queue (SPEC 러너 프로토콜, ADR-020 §2 · ADR-021 §3 · ADR-022 §2): claim with
// `FOR UPDATE SKIP LOCKED` under a claim lock, one-time credentials, event batches with lease
// renewal and stop signal, tar result upload, finish, and the lease / time-limit sweeper.
import type { Readable } from 'node:stream';
import type { ClaimedRun, EventsRequest, EventsResponse, FinishRequest, RunStatus } from '@euta-cloud/shared';
import { manualMarker, RUNNER_FINISH_STATUSES } from '@euta-cloud/shared';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { credentialAad, decryptSecret } from '../crypto.js';
import type { Tx } from '../db/index.js';
import { credentials, environments, runs } from '../db/schema.js';
import { AppError, notFound } from '../http.js';
import { afterTerminal, runnerActor, SYSTEM_ACTOR, type RunRow } from './runs.js';
import { extractTar } from './tar-upload.js';

/** Upper bound for the claim long-poll. */
export const MAX_CLAIM_WAIT_MS = 25_000;
/** A runner that ignores a timeout stop request for this long is marked `timeout` by the server. */
export const TIMEOUT_GRACE_MS = 5 * 60_000;

const leaseLost = () => new AppError(409, 'LEASE_LOST', 'this runner no longer holds the run (cancelled, timed out or lease expired)');

const basename = (p: string) => p.split('/').pop() || 'script.yaml';

/**
 * Take one claimable run, or null. Claimable = queued script run of a live project whose
 * (environment, credential name) set does not overlap an active run, and whose earlier suite
 * siblings are all terminal. Claims are serialized with a transaction advisory lock: the
 * same-credential rule spans rows, which SKIP LOCKED alone cannot enforce (two runners could each
 * lock a different queued run sharing a credential).
 */
export async function claimRun(ctx: AppContext, runnerId: string, location: string): Promise<ClaimedRun | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('euta_run_claim'))`);
      const picked = await tx.execute<{ id: string }>(sql`
        select r.id from runs r join projects p on p.id = r.project_id
        where r.status = 'queued' and r.kind = 'script' and p.deleted_at is null
          and not exists (
            select 1 from runs a
            where a.kind = 'script' and a.status in ('leased', 'running') and a.environment_id = r.environment_id
              and a.credential_names && r.credential_names)
          and (r.parent_run_id is null or not exists (
            select 1 from runs s
            where s.parent_run_id = r.parent_run_id and s.order_index < r.order_index
              and s.status in ('queued', 'leased', 'running')))
        order by r.created_at, r.order_index nulls first
        limit 1
        for update of r skip locked`);
      const id = picked.rows[0]?.id;
      if (!id) return { kind: 'none' as const };
      const [run] = await tx.select().from(runs).where(eq(runs.id, id));
      const [env] = run!.environmentId ? await tx.select().from(environments).where(eq(environments.id, run!.environmentId)) : [];
      const now = ctx.clock.now();
      if (!env || !run!.scriptSource) {
        const [r] = await tx
          .update(runs)
          .set({ status: 'error', error: env ? 'script text missing' : 'the environment was deleted before the run started', finishedAt: now })
          .where(eq(runs.id, id))
          .returning();
        await afterTerminal(ctx, tx, r!, SYSTEM_ACTOR);
        return { kind: 'retry' as const };
      }
      const leaseExpiresAt = new Date(now.getTime() + ctx.config.leaseTtlMs);
      const [r] = await tx
        .update(runs)
        .set({ status: 'leased', leaseRunnerId: runnerId, leaseExpiresAt, leasedAt: now, runnerLocation: location })
        .where(eq(runs.id, id))
        .returning();
      if (r!.parentRunId) {
        const [parent] = await tx
          .update(runs)
          .set({ status: 'running', startedAt: now, runnerLocation: location })
          .where(and(eq(runs.id, r!.parentRunId), eq(runs.status, 'queued')))
          .returning();
        if (parent) await ctx.feed.append(tx, parent.projectId, 'run.started', null, { runId: parent.id });
      }
      await ctx.feed.append(tx, r!.projectId, 'run.leased', null, { runId: r!.id, runnerLocation: location, ...(r!.parentRunId ? { parentRunId: r!.parentRunId } : {}) });
      const claimed: ClaimedRun = {
        runId: r!.id,
        projectId: r!.projectId,
        scriptName: basename(r!.scriptPath ?? 'script.yaml'),
        scriptSource: r!.scriptSource!,
        contentHash: r!.contentHash ?? '',
        environment: { id: env.id, name: env.name, baseUrl: env.baseUrl, vars: env.vars, allowedDomains: env.allowedDomains },
        vars: r!.vars,
        browser: r!.browser,
        device: r!.device,
        timeLimitMs: r!.timeLimitSec * 1000,
        record: r!.record,
        credentialNames: r!.credentialNames,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
        heartbeatMs: ctx.config.runnerHeartbeatMs,
      };
      return { kind: 'run' as const, claimed };
    });
    if (result.kind === 'run') return result.claimed;
    if (result.kind === 'none') return null;
  }
  return null;
}

/** Undo a claim nobody received (runner disconnected mid long-poll). */
export async function releaseRun(ctx: AppContext, runId: string, runnerId: string): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [r] = await tx
      .update(runs)
      .set({ status: 'queued', leaseRunnerId: null, leaseExpiresAt: null, leasedAt: null, runnerLocation: null })
      .where(and(eq(runs.id, runId), eq(runs.leaseRunnerId, runnerId), eq(runs.status, 'leased')))
      .returning();
    if (r) await ctx.feed.notifyRuns(tx);
  });
}

/** Wait until the queue changes (NOTIFY from any server), the timeout passes, or `signal` aborts. */
export function waitForQueueChange(ctx: AppContext, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let off = () => {};
    const done = () => {
      clearTimeout(timer);
      off();
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    off = ctx.feed.onRunsChanged(done);
    if (signal.aborted) done();
    else signal.addEventListener('abort', done);
  });
}

async function ownedRun(tx: Tx, runId: string, runnerId: string): Promise<RunRow> {
  const [r] = await tx.select().from(runs).where(eq(runs.id, runId)).for('update');
  if (!r) throw notFound('run');
  if (r.leaseRunnerId !== runnerId || (r.status !== 'leased' && r.status !== 'running')) throw leaseLost();
  return r;
}

/** Credential values for this run — handed out once per run (SPEC 러너 프로토콜 2). Never logged. */
export async function issueCredentials(ctx: AppContext, runId: string, runnerId: string): Promise<Record<string, string>> {
  return ctx.db.transaction(async (tx) => {
    const r = await ownedRun(tx, runId, runnerId);
    if (r.credentialsIssuedAt) throw new AppError(409, 'CREDENTIALS_ALREADY_ISSUED', 'credentials for this run were already handed out');
    await tx.update(runs).set({ credentialsIssuedAt: ctx.clock.now() }).where(eq(runs.id, r.id));
    if (!r.credentialNames.length || !r.environmentId) return {};
    const rows = await tx
      .select({ name: credentials.name, ciphertext: credentials.ciphertext })
      .from(credentials)
      .where(and(eq(credentials.environmentId, r.environmentId), inArray(credentials.name, r.credentialNames)));
    const out: Record<string, string> = {};
    for (const c of rows) out[c.name] = decryptSecret(ctx.config.credentialsKey, credentialAad(r.environmentId, c.name), c.ciphertext);
    return out;
  });
}

const clip = (v: unknown, max = 500): unknown => {
  if (v === undefined) return undefined;
  const s = JSON.stringify(v);
  return s && s.length > max ? `${s.slice(0, max)}…` : v;
};

/**
 * Apply a batch of engine events: lease renewal, leased → running, step index / metrics / expect
 * results / summary into the run row, one `run.progress` feed entry per batch with step events
 * (the runner already batches 1 s / 50 events — this is the SSE progress batching of ADR-022).
 * Also turns an exceeded time limit into a stop request.
 */
export async function applyEvents(ctx: AppContext, runId: string, body: EventsRequest): Promise<EventsResponse> {
  return ctx.db.transaction(async (tx) => {
    const r = await ownedRun(tx, runId, body.runnerId);
    const now = ctx.clock.now();
    const set: Partial<typeof runs.$inferInsert> = { leaseExpiresAt: new Date(now.getTime() + ctx.config.leaseTtlMs) };
    let started = false;
    if (r.status === 'leased') {
      set.status = 'running';
      set.startedAt = now;
      started = true;
    }
    if (body.engineRunId && /^[A-Za-z0-9._-]{1,200}$/.test(body.engineRunId)) set.engineRunId = body.engineRunId;
    const steps: Record<string, unknown>[] = [];
    const metrics: Record<string, unknown>[] = [];
    const expects: Record<string, unknown>[] = [];
    let current = r.currentStep ?? null;
    let seq = r.eventSeq;
    let stepEvents = false;
    for (const e of Array.isArray(body.events) ? body.events : []) {
      const s = Number(e.seq);
      if (!Number.isFinite(s) || s <= seq) continue;
      seq = s;
      switch (e.type) {
        case 'step.started':
          current = { stepId: String(e.stepId), action: String(e.action), ...(e.name ? { name: String(e.name) } : {}) };
          stepEvents = true;
          break;
        case 'step.finished': {
          const manual = manualMarker(e.manual);
          steps.push({
            stepId: e.stepId,
            index: e.index,
            action: e.action,
            ...(e.name ? { name: e.name } : {}),
            status: e.status,
            durationMs: e.durationMs,
            ...(e.error ? { error: String(e.error).slice(0, 2000) } : {}),
            ...(e.reloads !== undefined ? { reloads: e.reloads } : {}),
            ...(manual ? { manual } : {}),
          });
          if (current?.stepId === e.stepId) current = null;
          stepEvents = true;
          break;
        }
        case 'metric.recorded':
          metrics.push({ name: e.name, value: e.value, unit: e.unit, ...(e.stepId ? { stepId: e.stepId } : {}) });
          break;
        case 'expect.evaluated':
          expects.push({ stepId: e.stepId, condition: e.condition, passed: e.passed, expected: clip(e.expected), actual: clip(e.actual) });
          break;
        case 'run.finished':
          set.summary = e.summary as RunRow['summary'];
          set.durationMs = typeof e.durationMs === 'number' ? Math.round(e.durationMs) : null;
          break;
        default:
          break;
      }
    }
    set.eventSeq = seq;
    set.currentStep = current;
    if (steps.length) set.steps = sql`${runs.steps} || ${JSON.stringify(steps)}::jsonb` as unknown as Record<string, unknown>[];
    if (metrics.length) set.metrics = sql`${runs.metrics} || ${JSON.stringify(metrics)}::jsonb` as unknown as Record<string, unknown>[];
    if (expects.length) set.expects = sql`${runs.expects} || ${JSON.stringify(expects)}::jsonb` as unknown as Record<string, unknown>[];
    // Time limit, counted from the lease (the engine may not have started yet).
    const from = (r.startedAt ?? r.leasedAt ?? now).getTime();
    let stop = (r.stopRequested as EventsResponse['stop']) ?? null;
    if (!stop && now.getTime() > from + r.timeLimitSec * 1000) {
      stop = 'timeout';
      set.stopRequested = 'timeout';
    }
    await tx.update(runs).set(set).where(eq(runs.id, r.id));
    const parent = r.parentRunId ? { parentRunId: r.parentRunId } : {};
    if (started) await ctx.feed.append(tx, r.projectId, 'run.started', null, { runId: r.id, ...parent });
    if (stepEvents) {
      await ctx.feed.append(tx, r.projectId, 'run.progress', null, { runId: r.id, ...parent, currentStep: current, stepsDone: (r.steps.length ?? 0) + steps.length });
    }
    return { stop, leaseExpiresAt: set.leaseExpiresAt!.toISOString() };
  });
}

/** Store the uploaded result tar (replacing a partial earlier attempt). */
export async function storeResult(ctx: AppContext, runId: string, runnerId: string, body: Readable): Promise<{ files: number; bytes: number }> {
  const r = await ctx.db.transaction((tx) => ownedRun(tx, runId, runnerId));
  await ctx.results.deleteRun(r.projectId, r.id);
  let res: { files: number; bytes: number };
  try {
    res = await extractTar(body, ctx.config.resultMaxRunBytes, (rel, data) => ctx.results.put(r.projectId, r.id, rel, data));
  } catch (e) {
    await ctx.results.deleteRun(r.projectId, r.id);
    throw e;
  }
  const now = ctx.clock.now();
  await ctx.db
    .update(runs)
    .set({ resultFiles: 'present', resultBytes: res.bytes, leaseExpiresAt: new Date(now.getTime() + ctx.config.leaseTtlMs) })
    .where(and(eq(runs.id, r.id), eq(runs.leaseRunnerId, runnerId)));
  return res;
}

/** Final state — only after the result upload (or with `uploadFailed` → aborted). */
export async function finishRun(ctx: AppContext, runId: string, body: FinishRequest): Promise<RunRow> {
  if (!(RUNNER_FINISH_STATUSES as readonly string[]).includes(body.status)) throw new AppError(422, 'VALIDATION_FAILED', `invalid finish status ${String(body.status)}`);
  return ctx.db.transaction(async (tx) => {
    const r = await ownedRun(tx, runId, body.runnerId);
    if (!body.uploadFailed && r.resultFiles !== 'present') throw new AppError(409, 'RESULT_NOT_UPLOADED', 'upload the result folder before finishing the run');
    let status: RunStatus;
    let error = body.error ? String(body.error).slice(0, 2000) : null;
    if (body.uploadFailed) {
      status = 'aborted';
      error = `result upload failed${error ? `: ${error}` : ''}`;
    } else if (r.stopRequested === 'cancel') status = 'cancelled';
    else if (r.stopRequested === 'timeout' || body.status === 'timeout') status = 'timeout';
    else if (body.status === 'cancelled') status = 'error';
    else status = body.status;
    if (status === 'timeout' && !error) error = `time limit exceeded (${r.timeLimitSec}s)`;
    const now = ctx.clock.now();
    const [done] = await tx
      .update(runs)
      .set({
        status,
        error,
        finishedAt: now,
        currentStep: null,
        leaseExpiresAt: null,
        ...(body.summary ? { summary: body.summary } : {}),
        ...(typeof body.durationMs === 'number' ? { durationMs: Math.round(body.durationMs) } : {}),
      })
      .where(eq(runs.id, r.id))
      .returning();
    await afterTerminal(ctx, tx, done!, runnerActor(r.runnerLocation));
    return done!;
  }).then(async (done) => {
    if (body.uploadFailed) await ctx.results.deleteRun(done.projectId, done.id);
    return done;
  });
}

/** Visual baselines of the run's (environment, runner location) — read for the runner. */
export async function runForBaselines(ctx: AppContext, runId: string, runnerId: string): Promise<RunRow> {
  const r = await ctx.db.transaction((tx) => ownedRun(tx, runId, runnerId));
  if (!r.environmentId) throw notFound('environment');
  return r;
}

/**
 * Sweeper (every ~15 s): expired lease → aborted; running past its time limit → stop request
 * (`timeout`); a runner that ignores the stop for TIMEOUT_GRACE_MS → timeout.
 */
export async function sweepRuns(ctx: AppContext): Promise<{ aborted: number; timeoutRequested: number; timedOut: number }> {
  const now = ctx.clock.now();
  const out = { aborted: 0, timeoutRequested: 0, timedOut: 0 };
  const expired = await ctx.db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.kind, 'script'), inArray(runs.status, ['leased', 'running']), lt(runs.leaseExpiresAt, now)));
  for (const { id } of expired) {
    await ctx.db.transaction(async (tx) => {
      const [r] = await tx.select().from(runs).where(eq(runs.id, id)).for('update');
      if (!r || (r.status !== 'leased' && r.status !== 'running') || !r.leaseExpiresAt || r.leaseExpiresAt >= now) return;
      const [done] = await tx
        .update(runs)
        .set({ status: 'aborted', error: 'the runner stopped renewing its lease (runner stopped or lost)', finishedAt: now, currentStep: null, leaseExpiresAt: null })
        .where(eq(runs.id, id))
        .returning();
      await afterTerminal(ctx, tx, done!, SYSTEM_ACTOR);
      out.aborted++;
    });
    // A partial upload of an aborted run is never served — drop it.
    const [gone] = await ctx.db.select({ projectId: runs.projectId, resultFiles: runs.resultFiles }).from(runs).where(eq(runs.id, id));
    if (gone && gone.resultFiles !== 'present') await ctx.results.deleteRun(gone.projectId, id);
  }
  const active = await ctx.db.select().from(runs).where(and(eq(runs.kind, 'script'), inArray(runs.status, ['leased', 'running'])));
  for (const r of active) {
    const from = (r.startedAt ?? r.leasedAt ?? now).getTime();
    const deadline = from + r.timeLimitSec * 1000;
    if (now.getTime() <= deadline) continue;
    await ctx.db.transaction(async (tx) => {
      if (!r.stopRequested) {
        await tx.update(runs).set({ stopRequested: 'timeout' }).where(and(eq(runs.id, r.id), sql`${runs.stopRequested} is null`));
        await ctx.feed.append(tx, r.projectId, 'run.timeout_requested', null, { runId: r.id });
        out.timeoutRequested++;
      } else if (r.stopRequested === 'timeout' && now.getTime() > deadline + TIMEOUT_GRACE_MS) {
        const [done] = await tx
          .update(runs)
          .set({ status: 'timeout', error: `time limit exceeded (${r.timeLimitSec}s); the runner did not stop the run`, finishedAt: now, currentStep: null, leaseExpiresAt: null })
          .where(and(eq(runs.id, r.id), inArray(runs.status, ['leased', 'running'])))
          .returning();
        if (done) {
          await afterTerminal(ctx, tx, done, SYSTEM_ACTOR);
          out.timedOut++;
        }
      }
    });
  }
  return out;
}
