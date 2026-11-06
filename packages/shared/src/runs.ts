// Cloud runs (SPEC_클라우드-실행-예약): statuses, request schemas, API shapes and the internal runner
// protocol types shared by server and runner.
import * as z from 'zod';
import { RUN_MAX_TIME_LIMIT_SEC, RUN_MIN_TIME_LIMIT_SEC, VAR_KEY } from './validation.js';

/**
 * queued → leased → running → passed | failed | error | timeout | aborted | cancelled.
 * queued → cancelled. skipped = a schedule occurrence that was not run (C3).
 */
export const RUN_STATUSES = ['queued', 'leased', 'running', 'passed', 'failed', 'error', 'timeout', 'aborted', 'cancelled', 'skipped'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES = ['leased', 'running'] as const satisfies readonly RunStatus[];
export const TERMINAL_RUN_STATUSES = ['passed', 'failed', 'error', 'timeout', 'aborted', 'cancelled', 'skipped'] as const satisfies readonly RunStatus[];
export const isTerminalRunStatus = (s: string): boolean => (TERMINAL_RUN_STATUSES as readonly string[]).includes(s);

/** web · app (local app delegation) · ai_mcp (personal token) · schedule (C3) · local_upload (C2). */
export const RUN_SOURCES = ['web', 'app', 'ai_mcp', 'schedule', 'local_upload'] as const;
export type RunSource = (typeof RUN_SOURCES)[number];
/** Sources a signed-in client may claim (token requests are always `ai_mcp`). */
export const CLIENT_RUN_SOURCES = ['web', 'app'] as const;


/** Statuses the runner may report on finish (stop requests override: cancel → cancelled, timeout → timeout). */
export const RUNNER_FINISH_STATUSES = ['passed', 'failed', 'error', 'timeout', 'cancelled'] as const;

export type RecordValue = boolean | 'on-failure';

const varValue = z.union([z.string().max(4000), z.number(), z.boolean()]);

export const runVarsSchema = z.record(z.string(), varValue).superRefine((vars, ctx) => {
  for (const k of Object.keys(vars)) {
    if (!VAR_KEY.test(k) || k.length > 64) ctx.addIssue({ code: 'custom', path: [k], message: `invalid variable name: ${k}` });
  }
  if (Object.keys(vars).length > 100) ctx.addIssue({ code: 'custom', message: 'too many variables (max 100)' });
});

/** `POST /api/projects/:id/runs` and `…/runs/precheck`. Exactly one target. */
export const runCreateSchema = z
  .object({
    scriptId: z.string().min(1).optional(),
    scriptPath: z.string().min(1).max(500).optional(),
    suiteId: z.string().min(1).optional(),
    /** Defaults to the suite's default environment, then the project's default environment. */
    environmentId: z.string().min(1).optional(),
    vars: runVarsSchema.optional(),
    /** Defaults to the project's run time limit (6 h); at most 24 h. */
    timeLimitSec: z.number().int().min(RUN_MIN_TIME_LIMIT_SEC).max(RUN_MAX_TIME_LIMIT_SEC).optional(),
    source: z.enum(CLIENT_RUN_SOURCES).optional(),
  })
  .refine((b) => [b.scriptId, b.scriptPath, b.suiteId].filter((v) => v !== undefined).length === 1, {
    message: 'give exactly one of scriptId, scriptPath, suiteId',
    path: ['target'],
  });
export type RunCreateInput = z.input<typeof runCreateSchema>;

export const runListQuerySchema = z.object({
  status: z.enum(RUN_STATUSES).optional(),
  /** Script id, script path or suite id. */
  target: z.string().max(500).optional(),
  env: z.string().max(100).optional(),
  source: z.enum(RUN_SOURCES).optional(),
  /** Run id cursor: runs requested before this one. */
  before: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Precheck failure kinds, in the order the checks run (the first one becomes the 422 code). */
export const PRECHECK_CODES = [
  'ENVIRONMENT_REQUIRED',
  'SCRIPT_INVALID',
  'OS_INPUT_NOT_ALLOWED',
  'SECRET_PLACEMENT',
  'CREDENTIALS_MISSING',
  'TARGET_NOT_PUBLIC',
] as const;
export type PrecheckCode = (typeof PRECHECK_CODES)[number];

export interface PrecheckProblem {
  code: PrecheckCode;
  message: string;
  /** Script path for suite runs. */
  script?: string;
  /** Validation issues / offending step paths. */
  issues?: { path: string; message: string }[];
  /** Missing credential names. */
  names?: string[];
}

export interface PrecheckResultDto {
  ok: boolean;
  problems: PrecheckProblem[];
  environment: { id: string; name: string } | null;
  /** Credential names the run(s) would use (same-credential rule key). */
  credentialNames: string[];
  scripts: { id: string; path: string; version: number }[];
}

export interface RunSummaryDto {
  total: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
}

export interface RunStepDto {
  stepId: string;
  index: number;
  action: string;
  name?: string;
  status: string;
  durationMs: number;
  error?: string;
  reloads?: number;
  /** DSL `manual` step (status `skipped`, never executed; ADR-037). Reached = no `error`; not reached after a failure = `error` set. */
  manual?: ManualMarker;
}

/** What a `manual` step asks a person to check — as written in the script (`${...}` references kept). */
export interface ManualMarker {
  instruction: string;
  reason?: string;
}

/**
 * The `manual` marker of an engine step result / `step.finished` event, kept as stored step data
 * (string fields only, clipped like step errors); undefined when absent or malformed.
 */
export function manualMarker(v: unknown, max = 2000): ManualMarker | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const { instruction, reason } = v as { instruction?: unknown; reason?: unknown };
  if (typeof instruction !== 'string') return undefined;
  return { instruction: instruction.slice(0, max), ...(typeof reason === 'string' && reason ? { reason: reason.slice(0, max) } : {}) };
}

export interface RunDto {
  id: string;
  kind: 'script' | 'suite';
  status: RunStatus;
  flaky: boolean;
  parentRunId: string | null;
  orderIndex: number | null;
  /** Suite child marked "항상 실행" (runs even after a suite cancel). */
  alwaysRun: boolean;
  /** `name` = YAML `name:` of the pinned version (null = none). */
  script: { id: string | null; path: string; name: string | null; version: number; contentHash: string } | null;
  suite: { id: string | null; name: string } | null;
  environment: { id: string | null; name: string };
  vars: Record<string, string | number | boolean>;
  source: RunSource;
  requestedBy: { id: string | null; label: string };
  timeLimitSec: number;
  record: { video: RecordValue; trace: RecordValue };
  credentialNames: string[];
  runnerLocation: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  summary: RunSummaryDto | null;
  /** Step currently running (live progress). */
  currentStep: { stepId: string; action: string; name?: string } | null;
  error: string | null;
  stopRequested: 'cancel' | 'timeout' | null;
  /** none = nothing uploaded (yet) · present · expired (retention removed the files; DB summary kept). */
  resultFiles: 'none' | 'present' | 'expired';
  /** `--device` preset passed to the engine (project default when the script sets none). */
  device: string | null;
  /** Schedule that created this run (source `schedule`). */
  scheduleId: string | null;
  /** The occurrence time a scheduled / skipped run belongs to. */
  scheduledFor: string | null;
  /** 1 = first attempt; 2 = the retry of a failed scheduled run (`retryOfRunId`). */
  attempt: number;
  retryOfRunId: string | null;
  /** The retry run, when this attempt was retried. */
  retryRunId?: string | null;
  /** Why a `skipped` occurrence did not run. */
  skipReason: 'overlap' | 'missed' | 'daily-cap' | null;
  /** Local upload whose script text matches no cloud version (SPEC 로컬 실행 올리기 "로컬 수정본"). */
  localModified: boolean;
}

export interface RunDetailDto extends RunDto {
  steps: RunStepDto[];
  metrics: { name: string; value: number; unit: string; stepId?: string }[];
  expects: { stepId: string; condition: string; passed: boolean }[];
  children?: RunDto[];
}

export interface RunFileDto {
  path: string;
  size: number;
}

/** Query of `POST /api/projects/:id/runs/upload` (body = tar of one engine run folder). */
export const runUploadQuerySchema = z.object({
  /** Cloud script path the local run executed (the app maps its working copy to it). */
  scriptPath: z.string().min(1).max(500),
  /** Cloud environment the local run used (optional — a local-only environment has none). */
  environmentId: z.string().min(1).optional(),
  /** Environment label when there is no cloud environment id. */
  environmentName: z.string().trim().min(1).max(40).optional(),
});

/** `GET /api/me/events` — app notifications (SPEC_클라우드-앱-연동 "앱 알림"). */
export interface UserEventDto {
  id: number;
  /**
   * failure · recovery · passed · flaky · skipped · aborted — scheduled run outcomes for project members;
   * run.finished — the caller's own cloud run ended.
   */
  kind: 'failure' | 'recovery' | 'passed' | 'flaky' | 'skipped' | 'aborted' | 'run.finished';
  at: string;
  projectId: string;
  runId: string | null;
  data: {
    projectName: string;
    target: string;
    environment: string;
    status: RunStatus;
    flaky: boolean;
    source: RunSource;
    scheduleName?: string;
    failedStep?: string;
    durationMs: number | null;
    url: string;
  };
}

// ── Internal runner protocol (/internal/*, runner token) ────────────────────

export interface ClaimRequest {
  runnerId: string;
  location: string;
  /** Free run slots on this runner (0 → nothing is handed out). */
  slots: number;
  /** Long-poll: wait up to this many ms for a run to become claimable (server caps it). */
  waitMs?: number;
}

export interface ClaimedRun {
  runId: string;
  projectId: string;
  /** Script file name for the temp dir (basename of the script path). */
  scriptName: string;
  /** Pinned script text. */
  scriptSource: string;
  contentHash: string;
  environment: { id: string; name: string; baseUrl: string; vars: Record<string, string>; allowedDomains: string[] };
  vars: Record<string, string | number | boolean>;
  /** `--browser` value, only when the script does not choose its own engine. */
  browser: string | null;
  /** `--device` preset, only when the script does not choose its own device (project default). */
  device: string | null;
  timeLimitMs: number;
  record: { video: RecordValue; trace: RecordValue };
  credentialNames: string[];
  leaseExpiresAt: string;
  heartbeatMs: number;
}

export interface EventsRequest {
  runnerId: string;
  /** Engine run directory name (once known). */
  engineRunId?: string;
  /** Engine events (steps.jsonl lines), already masked by the engine. */
  events: Record<string, unknown>[];
}

export interface EventsResponse {
  /** Kill the engine child: cancel (a person) or timeout (time limit). */
  stop: 'cancel' | 'timeout' | null;
  leaseExpiresAt: string;
}

export interface FinishRequest {
  runnerId: string;
  /** Engine outcome (or timeout/cancelled when the runner killed it). */
  status: (typeof RUNNER_FINISH_STATUSES)[number];
  summary?: RunSummaryDto | null;
  durationMs?: number | null;
  error?: string | null;
  /** The result upload failed after retries → run becomes `aborted` (ADR-021 §3). */
  uploadFailed?: boolean;
}

/** One script of a test set run, referenced in the report's comparison (1-based order in this run). */
export interface SuiteReportRef {
  order: number;
  path: string;
}

/** `GET /runs/:runId/suite-report` — the test set report screen of a set (parent) run (SPEC 프로젝트-관리 "테스트 세트 리포트"). */
export interface SuiteReportDto {
  /** Previous finished run of the same set in the same environment (null = none). */
  previous: { id: string; startedAt: string | null; queuedAt: string; status: RunStatus } | null;
  comparison: { newlyFailing: SuiteReportRef[]; recovered: SuiteReportRef[]; stillFailing: SuiteReportRef[]; stillPassing: SuiteReportRef[] } | null;
  /** Script `name:` of each child run (child run id → name) from its pinned script text — the screen shows names, paths small. */
  names: Record<string, string>;
  /** Failed children: the failing step (sentence from the pinned script version), its error and screenshot path in the child's result files. */
  failures: {
    runId: string;
    order: number;
    path: string;
    status: RunStatus;
    stepId: string | null;
    title: string | null;
    sentence: string | null;
    error: string | null;
    screenshot: string | null;
  }[];
  /** `manual` steps of the children (reached or not — the "수동 확인 필요" count of report.html), in run order. */
  manual: {
    runId: string;
    order: number;
    path: string;
    stepId: string;
    title: string | null;
    instruction: string;
    reason: string | null;
    /** false = not reached because an earlier step failed (the step has an `error`). */
    reached: boolean;
  }[];
}
