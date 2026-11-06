// Run requests (SPEC_클라우드-실행-예약 "실행 요청" · "사전 검사" · "취소"): server-side precheck with the
// engine's `cloudPrecheck`, queueing (the runs table is the queue, ADR-020 §2), DTOs and cancel.
import { cloudPrecheck } from '@euta/core/precheck';
import { parseYaml } from '@euta/core';
import {
  isTerminalRunStatus,
  type PrecheckProblem,
  type PrecheckResultDto,
  type RecordValue,
  type RunDetailDto,
  type RunDto,
  type RunSource,
  type RunStatus,
  runCreateSchema,
  runListQuerySchema,
} from '@euta-cloud/shared';
import { and, asc, desc, eq, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import type * as z from 'zod';
import type { AppContext } from '../context.js';
import type { DbOrTx, Tx } from '../db/index.js';
import { credentials, environments, runs, scripts, scriptVersions, suites } from '../db/schema.js';
import { AppError, notFound } from '../http.js';
import type { Actor, Principal, ProjectRow } from './access.js';
import { actorOf } from './access.js';
import { record } from './activity.js';
import { checkPublicAddress } from './address-check.js';
import { capReached, capRoom } from './daily-cap.js';
import { onTopLevelTerminal } from './outcomes.js';
import { checkScript } from './script-check.js';
import { scriptNameOf } from './script-name.js';

export type RunRow = typeof runs.$inferSelect;
type EnvRow = typeof environments.$inferSelect;
type RunCreate = z.output<typeof runCreateSchema>;

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null, label: '시스템' };
export const runnerActor = (location: string | null): Actor => ({ type: 'system', id: null, label: `러너${location ? ` (${location})` : ''}` });

interface PlannedScript {
  scriptId: string;
  path: string;
  version: number;
  source: string;
  contentHash: string;
  credentialNames: string[];
  record: { video: RecordValue; trace: RecordValue };
  browser: string | null;
  device: string | null;
  /** Suite item marked "항상 실행". */
  alwaysRun: boolean;
}

export interface RunPlan {
  problems: PrecheckProblem[];
  env: EnvRow | null;
  suite: { id: string; name: string } | null;
  scripts: PlannedScript[];
}

const recordValue = (v: unknown): RecordValue => (v === true || v === false || v === 'on-failure' ? v : 'on-failure');

/** Effective recording (cloud default `on-failure`, the script's `record` wins) and `--browser`/`--device` defaults. */
function scriptRunOptions(source: string, project: ProjectRow): Pick<PlannedScript, 'record' | 'browser' | 'device'> {
  const parsed = parseYaml(source);
  const doc = (parsed.value && typeof parsed.value === 'object' ? parsed.value : {}) as {
    record?: { video?: unknown; trace?: unknown };
    browser?: { engine?: unknown; device?: unknown };
  };
  return {
    record: { video: recordValue(doc.record?.video), trace: recordValue(doc.record?.trace) },
    browser: typeof doc.browser?.engine === 'string' ? null : project.browser.engine,
    device: typeof doc.browser?.device === 'string' ? null : (project.browser.device ?? null),
  };
}

type ProblemSink = (p: PrecheckProblem) => void;

/** Environment for a run: the requested one (404 if unknown) → `fallbackId` (suite default / project default). */
async function loadRunEnvironment(ctx: AppContext, project: ProjectRow, requestedId: string | undefined, fallbackId: string | null) {
  const envId = requestedId ?? fallbackId;
  let env: EnvRow | null = null;
  if (envId) {
    const [e] = await ctx.db.select().from(environments).where(and(eq(environments.id, envId), eq(environments.projectId, project.id)));
    if (!e && requestedId) throw notFound('environment');
    env = e ?? null;
  }
  const credNames = env
    ? new Set((await ctx.db.select({ name: credentials.name }).from(credentials).where(eq(credentials.environmentId, env.id))).map((c) => c.name))
    : new Set<string>();
  const runEnv: Record<string, string> = env ? { ...env.vars, BASE_URL: env.baseUrl } : {};
  return { env, credNames, runEnv };
}

/**
 * One script's cloud precheck (validation · input: os · secrets placement · credential names).
 * Problems go to `add`; returns the credential names the script uses.
 */
function checkScriptForRun(
  script: { source: string; validationOk: boolean; validationIssues: { path: string; message: string }[] },
  e: { hasEnv: boolean; runEnv: Record<string, string>; credNames: Set<string>; vars?: Record<string, string | number | boolean> },
  label: { script?: string },
  add: ProblemSink,
): string[] {
  if (!script.validationOk) {
    add({ code: 'SCRIPT_INVALID', message: 'the current script version has validation errors', ...label, issues: script.validationIssues });
  }
  const pre = cloudPrecheck(script.source, { env: e.runEnv, ...(e.vars ? { vars: e.vars } : {}) });
  const of = (kind: string) => pre.issues.filter((i) => i.kind === kind).map(({ path: p, message }) => ({ path: p, message }));
  const validation = of('validation');
  if (validation.length && script.validationOk) add({ code: 'SCRIPT_INVALID', message: 'the script does not pass validation for this environment', ...label, issues: validation });
  const os = of('os-input');
  if (os.length) add({ code: 'OS_INPUT_NOT_ALLOWED', message: '클라우드에서는 OS 입력을 쓸 수 없음 (input: os)', ...label, issues: os });
  const placement = of('secret-placement');
  if (placement.length) add({ code: 'SECRET_PLACEMENT', message: '${secrets.*} may only be used in fill/type values in cloud runs', ...label, issues: placement });
  const missing = e.hasEnv ? pre.secretNames.filter((n) => !e.credNames.has(n)) : [];
  if (missing.length) add({ code: 'CREDENTIALS_MISSING', message: `the environment has no test credentials named ${missing.join(', ')}`, ...label, names: missing });
  return pre.secretNames;
}

/** Public address of the environment URL (checked now, not the value stored at save time). */
async function targetProblem(ctx: AppContext, env: EnvRow | null): Promise<PrecheckProblem | null> {
  if (!env || ctx.config.allowPrivateTargets) return null;
  const check = await checkPublicAddress(env.baseUrl, ctx.resolveHost);
  return check.public ? null : { code: 'TARGET_NOT_PUBLIC', message: `클라우드에서 접속할 수 없는 주소: ${check.reason ?? env.baseUrl}` };
}

const PROBLEM_ORDER = ['SCRIPT_INVALID', 'OS_INPUT_NOT_ALLOWED', 'SECRET_PLACEMENT', 'CREDENTIALS_MISSING'];

function problemCollector() {
  const byCode = new Map<string, PrecheckProblem[]>();
  return {
    add: (p: PrecheckProblem) => void byCode.set(p.code, [...(byCode.get(p.code) ?? []), p]),
    ordered: () => PROBLEM_ORDER.flatMap((code) => byCode.get(code) ?? []),
  };
}

/** Resolve target + environment and run every precheck (all problems collected, in SPEC order). */
export async function planRun(ctx: AppContext, project: ProjectRow, body: RunCreate): Promise<RunPlan> {
  const { db } = ctx;
  const problems: PrecheckProblem[] = [];

  // ── Target
  let suite: { id: string; name: string; scriptIds: string[]; alwaysRun: string[]; defaultEnvironmentId: string | null } | null = null;
  let scriptIds: string[];
  if (body.suiteId) {
    const [s] = await db.select().from(suites).where(and(eq(suites.id, body.suiteId), eq(suites.projectId, project.id)));
    if (!s) throw notFound('suite');
    suite = { id: s.id, name: s.name, scriptIds: s.scriptIds, alwaysRun: s.alwaysRun, defaultEnvironmentId: s.defaultEnvironmentId };
    if (!s.scriptIds.length) throw new AppError(422, 'VALIDATION_FAILED', 'the suite has no scripts', [{ path: 'suiteId', message: 'empty suite' }]);
    scriptIds = s.scriptIds;
  } else {
    const where = body.scriptId ? eq(scripts.id, body.scriptId) : eq(scripts.path, body.scriptPath!);
    const [s] = await db.select({ id: scripts.id }).from(scripts).where(and(where, eq(scripts.projectId, project.id), isNull(scripts.deletedAt)));
    if (!s) throw notFound('script');
    scriptIds = [s.id];
  }
  const rows = await db
    .select({ s: scripts, v: scriptVersions })
    .from(scripts)
    .innerJoin(scriptVersions, and(eq(scriptVersions.scriptId, scripts.id), eq(scriptVersions.version, scripts.currentVersion)))
    .where(and(eq(scripts.projectId, project.id), isNull(scripts.deletedAt), inArray(scripts.id, scriptIds)));
  const byId = new Map(rows.map((r) => [r.s.id, r]));

  // ── Environment: request → suite default → project default
  const { env, credNames, runEnv } = await loadRunEnvironment(ctx, project, body.environmentId, suite?.defaultEnvironmentId ?? project.defaultEnvironmentId);
  if (!env) problems.push({ code: 'ENVIRONMENT_REQUIRED', message: 'choose an environment (the project has no default environment)' });

  // ── Per script: validation · input: os · secrets placement · credential names
  const planned: PlannedScript[] = [];
  const collected = problemCollector();
  for (const id of scriptIds) {
    const r = byId.get(id);
    if (!r) {
      collected.add({ code: 'SCRIPT_INVALID', message: `a script in the suite was deleted (${id})`, issues: [] });
      continue;
    }
    const path = r.s.path;
    const secretNames = checkScriptForRun(
      { source: r.v.source, validationOk: r.v.validationOk, validationIssues: r.v.validationIssues },
      { hasEnv: !!env, runEnv, credNames, ...(body.vars ? { vars: body.vars } : {}) },
      suite ? { script: path } : {},
      collected.add,
    );
    planned.push({
      scriptId: r.s.id,
      path,
      version: r.v.version,
      source: r.v.source,
      contentHash: r.v.contentHash,
      credentialNames: secretNames,
      ...scriptRunOptions(r.v.source, project),
      alwaysRun: !!suite?.alwaysRun.includes(r.s.id),
    });
  }
  problems.push(...collected.ordered());
  const target = await targetProblem(ctx, env);
  if (target) problems.push(target);
  return { problems, env, suite: suite ? { id: suite.id, name: suite.name } : null, scripts: planned };
}

/**
 * Precheck unsaved script text (remote MCP `validate_script`): engine validation + the same cloud
 * checks as a run request against the chosen environment (default: the project's).
 */
export async function precheckSource(
  ctx: AppContext,
  project: ProjectRow,
  source: string,
  opts: { environmentId?: string; vars?: Record<string, string | number | boolean> } = {},
): Promise<{ validation: { ok: boolean; issues: { path: string; message: string }[] }; precheck: Omit<PrecheckResultDto, 'scripts'> }> {
  const check = checkScript(source);
  const problems: PrecheckProblem[] = [];
  const { env, credNames, runEnv } = await loadRunEnvironment(ctx, project, opts.environmentId, project.defaultEnvironmentId);
  if (!env) problems.push({ code: 'ENVIRONMENT_REQUIRED', message: 'choose an environment (the project has no default environment)' });
  const collected = problemCollector();
  const names = check.parsed
    ? checkScriptForRun({ source, validationOk: check.ok, validationIssues: check.issues }, { hasEnv: !!env, runEnv, credNames, ...(opts.vars ? { vars: opts.vars } : {}) }, {}, collected.add)
    : (collected.add({ code: 'SCRIPT_INVALID', message: 'the script is not valid YAML', issues: check.issues }), []);
  problems.push(...collected.ordered());
  const target = await targetProblem(ctx, env);
  if (target) problems.push(target);
  return {
    validation: { ok: check.ok, issues: check.issues },
    precheck: { ok: problems.length === 0, problems, environment: env ? { id: env.id, name: env.name } : null, credentialNames: [...new Set(names)].sort() },
  };
}

export function precheckDto(plan: RunPlan): PrecheckResultDto {
  return {
    ok: plan.problems.length === 0,
    problems: plan.problems,
    environment: plan.env ? { id: plan.env.id, name: plan.env.name } : null,
    credentialNames: [...new Set(plan.scripts.flatMap((s) => s.credentialNames))].sort(),
    scripts: plan.scripts.map((s) => ({ id: s.scriptId, path: s.path, version: s.version })),
  };
}

export function precheckError(plan: RunPlan): AppError {
  const first = plan.problems[0]!;
  return new AppError(422, first.code, first.message, plan.problems);
}

/** Who/what queues a run and how (route requests, the scheduler, retries). */
export interface RunOrigin {
  actor: Actor;
  requestedBy: string | null;
  source: RunSource;
  vars: Record<string, string | number | boolean>;
  timeLimitSec: number;
  scheduleId?: string | null;
  scheduledFor?: Date | null;
  attempt?: number;
  retryOfRunId?: string | null;
}

/** Script runs a plan would add to the daily cap. */
export const planScriptCount = (plan: RunPlan): number => plan.scripts.length;

/** Insert a planned run (suite → parent + ordered children) in the caller's transaction. Returns the top-level id. */
export async function insertPlannedRun(ctx: AppContext, tx: Tx, project: ProjectRow, plan: RunPlan, o: RunOrigin): Promise<string> {
  const env = plan.env!;
  const now = ctx.clock.now();
  const common = {
    projectId: project.id,
    environmentId: env.id,
    environmentName: env.name,
    vars: o.vars,
    source: o.source,
    requestedBy: o.requestedBy,
    requestedByLabel: o.actor.label,
    actorType: o.actor.type,
    timeLimitSec: o.timeLimitSec,
    status: 'queued' as const,
    scheduleId: o.scheduleId ?? null,
    scheduledFor: o.scheduledFor ?? null,
    attempt: o.attempt ?? 1,
    createdAt: now,
  };
  const scriptRow = (s: PlannedScript) => ({
    kind: 'script',
    scriptId: s.scriptId,
    scriptPath: s.path,
    scriptVersion: s.version,
    contentHash: s.contentHash,
    scriptSource: s.source,
    credentialNames: s.credentialNames,
    record: s.record,
    browser: s.browser,
    device: s.device,
  });
  let topId: string;
  let summary: string;
  if (plan.suite) {
    const [parent] = await tx
      .insert(runs)
      .values({
        ...common,
        kind: 'suite',
        suiteId: plan.suite.id,
        suiteName: plan.suite.name,
        retryOfRunId: o.retryOfRunId ?? null,
        credentialNames: [...new Set(plan.scripts.flatMap((s) => s.credentialNames))].sort(),
        record: { video: 'on-failure', trace: 'on-failure' },
      })
      .returning({ id: runs.id });
    topId = parent!.id;
    await tx.insert(runs).values(
      plan.scripts.map((s, i) => ({ ...common, ...scriptRow(s), parentRunId: topId, orderIndex: i, alwaysRun: s.alwaysRun, suiteId: plan.suite!.id, suiteName: plan.suite!.name })),
    );
    summary = `실행 요청: 테스트 세트 ${plan.suite.name} (${plan.scripts.length}개) @ ${env.name}`;
  } else {
    const s = plan.scripts[0]!;
    const [row] = await tx
      .insert(runs)
      .values({ ...common, ...scriptRow(s), retryOfRunId: o.retryOfRunId ?? null })
      .returning({ id: runs.id });
    topId = row!.id;
    summary = `실행 요청: ${s.path} v${s.version} @ ${env.name}`;
  }
  if ((o.attempt ?? 1) > 1) summary = `재실행 ${summary}`;
  await record(tx, ctx.feed, o.actor, {
    projectId: project.id,
    kind: 'run.requested',
    summary,
    targetType: 'run',
    targetId: topId,
    details: {
      source: o.source,
      environment: env.name,
      ...(plan.suite ? { suite: plan.suite.name } : { script: plan.scripts[0]!.path }),
      ...(o.scheduleId ? { scheduleId: o.scheduleId } : {}),
      ...(o.retryOfRunId ? { retryOfRunId: o.retryOfRunId } : {}),
    },
    feedData: { runId: topId, status: 'queued', source: o.source, ...(o.retryOfRunId ? { retryOfRunId: o.retryOfRunId } : {}) },
  });
  await ctx.feed.notifyRuns(tx);
  return topId;
}

/** Queue a person's / token's run request (daily cap checked under the project row lock). */
export async function createRun(ctx: AppContext, principal: Principal, project: ProjectRow, body: RunCreate, plan: RunPlan): Promise<string> {
  const actor = actorOf(principal);
  const source: RunSource = principal.via === 'token' ? 'ai_mcp' : (body.source ?? 'web');
  return ctx.db.transaction(async (tx) => {
    const room = await capRoom(tx, project.id, project.dailyRunCap, ctx.clock.now(), planScriptCount(plan));
    if (!room.ok) throw capReached(room);
    return insertPlannedRun(ctx, tx, project, plan, {
      actor,
      requestedBy: principal.user.id,
      source,
      vars: body.vars ?? {},
      timeLimitSec: body.timeLimitSec ?? project.runTimeLimitSec,
    });
  });
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

export function runDto(r: RunRow): RunDto {
  return {
    id: r.id,
    kind: r.kind as RunDto['kind'],
    status: r.status as RunStatus,
    flaky: r.flaky,
    parentRunId: r.parentRunId,
    orderIndex: r.orderIndex,
    alwaysRun: r.alwaysRun,
    script:
      r.kind === 'script'
        ? { id: r.scriptId, path: r.scriptPath ?? '', name: scriptNameOf(r.scriptSource, r.contentHash), version: r.scriptVersion ?? 0, contentHash: r.contentHash ?? '' }
        : null,
    suite: r.suiteName ? { id: r.suiteId, name: r.suiteName } : null,
    environment: { id: r.environmentId, name: r.environmentName },
    vars: r.vars,
    source: r.source as RunSource,
    requestedBy: { id: r.requestedBy, label: r.requestedByLabel },
    timeLimitSec: r.timeLimitSec,
    record: r.record,
    credentialNames: r.credentialNames,
    runnerLocation: r.runnerLocation,
    queuedAt: r.createdAt.toISOString(),
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    durationMs: r.durationMs ?? (r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null),
    summary: r.summary ?? null,
    currentStep: r.currentStep ?? null,
    error: r.error,
    stopRequested: (r.stopRequested as RunDto['stopRequested']) ?? null,
    resultFiles: r.resultFiles as RunDto['resultFiles'],
    device: r.device,
    scheduleId: r.scheduleId,
    scheduledFor: r.scheduledFor?.toISOString() ?? null,
    attempt: r.attempt,
    retryOfRunId: r.retryOfRunId,
    skipReason: (r.skipReason as RunDto['skipReason']) ?? null,
    localModified: r.localModified,
  };
}

export function runDetailDto(r: RunRow, children?: RunRow[]): RunDetailDto {
  return {
    ...runDto(r),
    steps: r.steps as unknown as RunDetailDto['steps'],
    metrics: r.metrics as unknown as RunDetailDto['metrics'],
    expects: r.expects as unknown as RunDetailDto['expects'],
    ...(children ? { children: children.map(runDto) } : {}),
  };
}

export async function loadRun(db: DbOrTx, projectId: string, runId: string): Promise<RunRow> {
  const [r] = await db.select().from(runs).where(and(eq(runs.id, runId), eq(runs.projectId, projectId)));
  if (!r) throw notFound('run');
  return r;
}

/** Top-level runs of a project, newest first (REST list + remote MCP `list_runs`). */
export async function listRunRows(ctx: AppContext, projectId: string, q: z.output<typeof runListQuerySchema>): Promise<RunRow[]> {
  const { db } = ctx;
  const where: (SQL | undefined)[] = [eq(runs.projectId, projectId), isNull(runs.parentRunId)];
  if (q.status) where.push(eq(runs.status, q.status));
  if (q.source) where.push(eq(runs.source, q.source));
  if (q.env) where.push(or(eq(runs.environmentId, q.env), eq(runs.environmentName, q.env)));
  if (q.target) where.push(or(eq(runs.scriptId, q.target), eq(runs.scriptPath, q.target), eq(runs.suiteId, q.target)));
  if (q.before) {
    const [b] = await db.select({ createdAt: runs.createdAt }).from(runs).where(and(eq(runs.id, q.before), eq(runs.projectId, projectId)));
    if (b) where.push(lt(runs.createdAt, b.createdAt));
  }
  return db
    .select()
    .from(runs)
    .where(and(...where))
    .orderBy(desc(runs.createdAt), desc(runs.id))
    .limit(q.limit);
}

export async function childrenOf(db: DbOrTx, parentId: string): Promise<RunRow[]> {
  return db.select().from(runs).where(eq(runs.parentRunId, parentId)).orderBy(asc(runs.orderIndex));
}

// ── Terminal transitions ─────────────────────────────────────────────────────

/** Record a run's end (activity + feed), wake the queue and settle a suite parent. Caller's transaction. */
export async function afterTerminal(ctx: AppContext, tx: Tx, r: RunRow, actor: Actor): Promise<void> {
  const label = r.kind === 'suite' ? `테스트 세트 ${r.suiteName}` : (r.scriptPath ?? r.id);
  await record(tx, ctx.feed, actor, {
    projectId: r.projectId,
    kind: r.status === 'cancelled' ? 'run.cancelled' : 'run.finished',
    summary: `실행 ${r.status === 'cancelled' ? '취소' : '종료'}: ${label} — ${r.status}`,
    targetType: 'run',
    targetId: r.id,
    details: { status: r.status, ...(r.parentRunId ? { parentRunId: r.parentRunId } : {}), ...(r.error ? { error: r.error.slice(0, 300) } : {}) },
    feedData: { runId: r.id, status: r.status, ...(r.parentRunId ? { parentRunId: r.parentRunId } : {}), summary: r.summary ?? null },
  });
  await ctx.feed.notifyRuns(tx);
  if (r.parentRunId) await settleSuite(ctx, tx, r.parentRunId);
  // Retry · flaky · notifications (C3) — top-level runs only; a suite child is covered by its parent.
  else await onTopLevelTerminal(ctx, tx, r);
}

/**
 * A suite parent ends when every child is terminal: cancelled (suite cancel) · passed (all passed) ·
 * failed (anything else). Summary counts children by outcome.
 */
export async function settleSuite(ctx: AppContext, tx: Tx, parentId: string): Promise<void> {
  const [parent] = await tx.select().from(runs).where(eq(runs.id, parentId)).for('update');
  if (!parent || isTerminalRunStatus(parent.status)) return;
  const kids = await childrenOf(tx, parentId);
  if (kids.some((k) => !isTerminalRunStatus(k.status))) return;
  const count = (pred: (s: string) => boolean) => kids.filter((k) => pred(k.status)).length;
  const status: RunStatus = parent.stopRequested === 'cancel' ? 'cancelled' : kids.every((k) => k.status === 'passed') ? 'passed' : 'failed';
  const now = ctx.clock.now();
  const [done] = await tx
    .update(runs)
    .set({
      status,
      finishedAt: now,
      currentStep: null,
      summary: {
        total: kids.length,
        passed: count((s) => s === 'passed'),
        failed: count((s) => s === 'failed'),
        error: count((s) => ['error', 'timeout', 'aborted'].includes(s)),
        skipped: count((s) => s === 'cancelled' || s === 'skipped'),
      },
      durationMs: parent.startedAt ? now.getTime() - parent.startedAt.getTime() : null,
    })
    .where(eq(runs.id, parentId))
    .returning();
  await afterTerminal(ctx, tx, done!, SYSTEM_ACTOR);
}

/**
 * Cancel (SPEC 취소): queued → cancelled now; leased/running → stop request (runner kills the engine,
 * uploads what exists, finishes as cancelled). A suite cancels its queued children and stops the
 * active one; the parent settles when that child ends. Children marked "항상 실행" are spared: a
 * queued one stays queued (claimable once its earlier siblings are terminal), a running one finishes
 * (SPEC 테스트 세트, ADR-031).
 */
export async function cancelRun(ctx: AppContext, principal: Principal, projectId: string, runId: string): Promise<RunRow> {
  const actor = actorOf(principal);
  return ctx.db.transaction(async (tx) => {
    const [r] = await tx.select().from(runs).where(and(eq(runs.id, runId), eq(runs.projectId, projectId))).for('update');
    if (!r) throw notFound('run');
    if (isTerminalRunStatus(r.status)) throw new AppError(409, 'RUN_FINISHED', `the run already ended (${r.status})`);
    const now = ctx.clock.now();
    const targets = r.kind === 'suite' ? (await childrenOf(tx, r.id)).filter((k) => !isTerminalRunStatus(k.status) && !k.alwaysRun) : [r];
    if (r.kind === 'suite') await tx.update(runs).set({ stopRequested: 'cancel', stopRequestedBy: principal.user.id }).where(eq(runs.id, r.id));
    let stopping = false;
    for (const t of targets) {
      if (t.status === 'queued') {
        const [c] = await tx
          .update(runs)
          .set({ status: 'cancelled', finishedAt: now, stopRequested: 'cancel', stopRequestedBy: principal.user.id })
          .where(eq(runs.id, t.id))
          .returning();
        // Children are recorded quietly; the suite's own entry covers them.
        if (r.kind === 'suite') await ctx.feed.append(tx, projectId, 'run.finished', actor.id, { runId: c!.id, status: 'cancelled', parentRunId: r.id });
        else await afterTerminal(ctx, tx, c!, actor);
      } else {
        stopping = true;
        await tx.update(runs).set({ stopRequested: 'cancel', stopRequestedBy: principal.user.id }).where(eq(runs.id, t.id));
        await ctx.feed.append(tx, projectId, 'run.cancel_requested', actor.id, { runId: t.id, ...(t.parentRunId ? { parentRunId: t.parentRunId } : {}) });
      }
    }
    if (r.kind === 'suite' || stopping) {
      await record(tx, ctx.feed, actor, {
        projectId,
        kind: 'run.cancel_requested',
        summary: `실행 취소 요청: ${r.kind === 'suite' ? `테스트 세트 ${r.suiteName}` : r.scriptPath}`,
        targetType: 'run',
        targetId: r.id,
        feedData: { runId: r.id },
      });
    }
    if (r.kind === 'suite') {
      await ctx.feed.notifyRuns(tx);
      await settleSuite(ctx, tx, r.id);
    }
    const [out] = await tx.select().from(runs).where(eq(runs.id, r.id));
    return out!;
  });
}
