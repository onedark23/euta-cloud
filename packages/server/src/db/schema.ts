// Drizzle schema (ADR-020). Better Auth tables first (field names = Better Auth field names so the
// Drizzle adapter maps them), then euta cloud tables. SQL names are snake_case.
// Runs (= the run queue, ADR-020 §2) come after the change feed, then schedules and notifications (C3).
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const id = () => text('id').primaryKey().$defaultFn(() => randomUUID());

// ── Better Auth core ─────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  /** active · pending (admin approval mode) · deactivated */
  status: text('status').notNull().default('active'),
  isAdmin: boolean('is_admin').notNull().default(false),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: ts('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: ts('access_token_expires_at'),
    refreshTokenExpiresAt: ts('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('accounts_user_idx').on(t.userId)],
);

export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

// ── Better Auth plugins: api-key (personal tokens) · device authorization ────

export const apikeys = pgTable(
  'apikeys',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').notNull().default('default'),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    prefix: text('prefix'),
    /** SHA-256 hash of the key (plugin default; plaintext is never stored). */
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: ts('last_refill_at'),
    enabled: boolean('enabled').default(true),
    rateLimitEnabled: boolean('rate_limit_enabled').default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window'),
    rateLimitMax: integer('rate_limit_max'),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: ts('last_request'),
    expiresAt: ts('expires_at'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (t) => [index('apikeys_key_idx').on(t.key), index('apikeys_reference_idx').on(t.referenceId), index('apikeys_config_idx').on(t.configId)],
);

export const deviceCodes = pgTable('device_codes', {
  id: text('id').primaryKey(),
  deviceCode: text('device_code').notNull(),
  userCode: text('user_code').notNull(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
  status: text('status').notNull(),
  lastPolledAt: ts('last_polled_at'),
  pollingInterval: integer('polling_interval'),
  clientId: text('client_id'),
  scope: text('scope'),
});

// ── Organization / account hardening ─────────────────────────────────────────

/** Single organization (PoC). Row id = 1. Allowed domains mirror server config at startup. */
export const orgSettings = pgTable('org_settings', {
  id: integer('id').primaryKey().default(1),
  name: text('name').notNull().default('euta'),
  allowedDomains: text('allowed_domains').array().notNull().default(sql`'{}'::text[]`),
  approvalMode: boolean('approval_mode').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Login lockout bookkeeping: 5 consecutive failures → locked for 10 minutes. */
export const loginAttempts = pgTable('login_attempts', {
  email: text('email').primaryKey(),
  failures: integer('failures').notNull().default(0),
  lockedUntil: ts('locked_until'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

// ── Projects ─────────────────────────────────────────────────────────────────

export const projects = pgTable(
  'projects',
  {
    id: id(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    browser: jsonb('browser').$type<{ engine: 'chromium' | 'firefox' | 'webkit'; device?: string }>().notNull(),
    testRules: text('test_rules').notNull().default(''),
    teamsWebhookUrl: text('teams_webhook_url'),
    defaultEnvironmentId: text('default_environment_id'),
    /** Default run time limit in seconds (SPEC 실행 요청: 6 h, at most 24 h). */
    runTimeLimitSec: integer('run_time_limit_sec').notNull().default(21600),
    /** Off-by-default notification toggles (SPEC 알림). */
    notifySettings: jsonb('notify_settings')
      .$type<{ skipped: boolean; aborted: boolean; passed: boolean; flaky: boolean }>()
      .notNull()
      .default({ skipped: false, aborted: false, passed: false, flaky: false }),
    /** Script runs per Asia/Seoul day (PLAN 결정 "실사용 부작용"). */
    dailyRunCap: integer('daily_run_cap').notNull().default(50),
    /** Last change-feed sequence number issued for this project (bumped with each feed insert). */
    feedSeq: bigint('feed_seq', { mode: 'number' }).notNull().default(0),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    /** Trash: set on delete; restorable for 30 days, then purged. */
    deletedAt: ts('deleted_at'),
    deletedBy: text('deleted_by').references(() => users.id, { onDelete: 'set null' }),
    /** Stage 15 visibility: `org` (every org member views) · `members` (invited only, others 404). */
    visibility: text('visibility').notNull().default('org'),
    /** Birth record (immutable): `web` · `app` · `unknown` (created before stage 15). */
    origin: text('origin').notNull().default('unknown'),
    /** origin=app: the uploading app's local project id. Filled once when an `unknown` project is merged. */
    originLocalId: text('origin_local_id'),
  },
  (t) => [index('projects_deleted_idx').on(t.deletedAt), index('projects_origin_local_idx').on(t.createdBy, t.originLocalId)],
);

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** owner · editor · runner · viewer (non-members of an org-visible project are viewers) */
    role: text('role').notNull(),
    addedBy: text('added_by').references(() => users.id, { onDelete: 'set null' }),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index('project_members_user_idx').on(t.userId)],
);

export const environments = pgTable(
  'environments',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    vars: jsonb('vars').$type<Record<string, string>>().notNull().default({}),
    allowedDomains: text('allowed_domains').array().notNull().default(sql`'{}'::text[]`),
    /** Public-address check of the base URL host at save time. */
    cloudRunnable: boolean('cloud_runnable').notNull().default(true),
    addressCheckReason: text('address_check_reason'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('environments_project_name_uq').on(t.projectId, t.name)],
);

/** Test credentials — write-only, AES-256-GCM encrypted with the server key (CREDENTIALS_KEY). */
export const credentials = pgTable(
  'credentials',
  {
    id: id(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** `v1:<iv b64>:<tag b64>:<ciphertext b64>`, AAD = `<environmentId>/<name>` */
    ciphertext: text('ciphertext').notNull(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('credentials_env_name_uq').on(t.environmentId, t.name)],
);

// ── Scripts ──────────────────────────────────────────────────────────────────

export const scripts = pgTable(
  'scripts',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    /** Number of the current (latest) version. */
    currentVersion: integer('current_version').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
    deletedBy: text('deleted_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    // Live paths are unique; a deleted script keeps its path until restored or purged.
    uniqueIndex('scripts_project_path_live_uq').on(t.projectId, t.path).where(sql`${t.deletedAt} is null`),
    index('scripts_project_idx').on(t.projectId),
  ],
);

export const scriptVersions = pgTable(
  'script_versions',
  {
    id: id(),
    scriptId: text('script_id')
      .notNull()
      .references(() => scripts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    source: text('source').notNull(),
    contentHash: text('content_hash').notNull(),
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
    /** web · app · ai_mcp · external · revert */
    origin: text('origin').notNull(),
    memo: text('memo'),
    validationOk: boolean('validation_ok').notNull(),
    validationIssues: jsonb('validation_issues').$type<{ path: string; message: string }[]>().notNull().default([]),
    /** For `revert`: the version whose text was restored. */
    revertedFrom: integer('reverted_from'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('script_versions_script_version_uq').on(t.scriptId, t.version)],
);

export const suites = pgTable('suites', {
  id: id(),
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  /** Ordered script ids (ids survive renames). */
  scriptIds: jsonb('script_ids').$type<string[]>().notNull().default([]),
  /** "항상 실행" script ids (subset of scriptIds): still run after a suite cancel (ADR-031). */
  alwaysRun: jsonb('always_run').$type<string[]>().notNull().default([]),
  defaultEnvironmentId: text('default_environment_id').references(() => environments.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

// ── Activity log · change feed ───────────────────────────────────────────────

export const activity = pgTable(
  'activity',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    at: ts('at').notNull().defaultNow(),
    /** user · ai · schedule · system */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    /** Display label at the time (user name; for AI: "AI — <owner> (<token name>)"). */
    actorLabel: text('actor_label').notNull(),
    /** e.g. project.created · script.saved · credential.set (never contains values) */
    kind: text('kind').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    summary: text('summary').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('activity_project_idx').on(t.projectId, t.id), index('activity_at_idx').on(t.at)],
);

/** Per-project change feed; `seq` increases per project and is the SSE event id (ADR-022). */
export const changeFeed = pgTable(
  'change_feed',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    at: ts('at').notNull().defaultNow(),
    kind: text('kind').notNull(),
    actorId: text('actor_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.seq] }), index('change_feed_at_idx').on(t.at)],
);

// ── Runs (the queue itself, ADR-020 §2) ──────────────────────────────────────

/**
 * One row per run. Script runs are claimable by runners; a suite run is a parent row (never
 * claimed) plus one child script run per suite entry, executed in `order_index` order — a child is
 * claimable only when every earlier sibling is terminal (continue on failure).
 */
export const runs = pgTable(
  'runs',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** script · suite */
    kind: text('kind').notNull(),
    parentRunId: text('parent_run_id').references((): AnyPgColumn => runs.id, { onDelete: 'cascade' }),
    orderIndex: integer('order_index'),
    /** Suite child marked "항상 실행" when requested: a suite cancel leaves it queued / running (ADR-031). */
    alwaysRun: boolean('always_run').notNull().default(false),
    suiteId: text('suite_id').references(() => suites.id, { onDelete: 'set null' }),
    suiteName: text('suite_name'),
    scriptId: text('script_id').references(() => scripts.id, { onDelete: 'set null' }),
    scriptPath: text('script_path'),
    /** Script version pinned at request time (SPEC "스크립트 버전 고정"). */
    scriptVersion: integer('script_version'),
    contentHash: text('content_hash'),
    /** Copy of the pinned version's text — versions beyond the latest 200 are pruned. */
    scriptSource: text('script_source'),
    environmentId: text('environment_id').references(() => environments.id, { onDelete: 'set null' }),
    environmentName: text('environment_name').notNull(),
    /** Request `vars` overrides (`--var k=v`). */
    vars: jsonb('vars').$type<Record<string, string | number | boolean>>().notNull().default({}),
    /** web · app · ai_mcp · schedule · local_upload */
    source: text('source').notNull(),
    requestedBy: text('requested_by').references(() => users.id, { onDelete: 'set null' }),
    requestedByLabel: text('requested_by_label').notNull(),
    /** user · ai · schedule · system */
    actorType: text('actor_type').notNull(),
    /** `${secrets.*}` names used — the same-credential rule key with environment_id. */
    credentialNames: text('credential_names').array().notNull().default(sql`'{}'::text[]`),
    timeLimitSec: integer('time_limit_sec').notNull(),
    record: jsonb('record').$type<{ video: boolean | 'on-failure'; trace: boolean | 'on-failure' }>().notNull(),
    /** --browser for the engine when the script does not pick one (project default). */
    browser: text('browser'),
    /** --device for the engine when the script does not pick one (project default). */
    device: text('device'),
    /** queued · leased · running · passed · failed · error · timeout · aborted · cancelled · skipped */
    status: text('status').notNull(),
    /** Retry passed on the second attempt (C3 schedules). */
    flaky: boolean('flaky').notNull().default(false),
    leaseRunnerId: text('lease_runner_id'),
    leaseExpiresAt: ts('lease_expires_at'),
    runnerLocation: text('runner_location'),
    credentialsIssuedAt: ts('credentials_issued_at'),
    /** cancel · timeout — the runner is told to kill the engine. */
    stopRequested: text('stop_requested'),
    stopRequestedBy: text('stop_requested_by'),
    engineRunId: text('engine_run_id'),
    /** Highest engine event seq applied (batches are idempotent on retry). */
    eventSeq: integer('event_seq').notNull().default(0),
    summary: jsonb('summary').$type<{ total: number; passed: number; failed: number; error: number; skipped: number } | null>(),
    durationMs: integer('duration_ms'),
    currentStep: jsonb('current_step').$type<{ stepId: string; action: string; name?: string } | null>(),
    steps: jsonb('steps').$type<Record<string, unknown>[]>().notNull().default([]),
    metrics: jsonb('metrics').$type<Record<string, unknown>[]>().notNull().default([]),
    expects: jsonb('expects').$type<Record<string, unknown>[]>().notNull().default([]),
    error: text('error'),
    /** none · present · expired */
    resultFiles: text('result_files').notNull().default('none'),
    resultBytes: bigint('result_bytes', { mode: 'number' }).notNull().default(0),
    /** Schedule that created the run (C3). */
    scheduleId: text('schedule_id').references((): AnyPgColumn => schedules.id, { onDelete: 'set null' }),
    /** The occurrence this scheduled / skipped run belongs to. */
    scheduledFor: ts('scheduled_for'),
    /** 1, or 2 for the retry of a failed scheduled run. */
    attempt: integer('attempt').notNull().default(1),
    retryOfRunId: text('retry_of_run_id').references((): AnyPgColumn => runs.id, { onDelete: 'set null' }),
    /** overlap · missed · daily-cap (status `skipped`). */
    skipReason: text('skip_reason'),
    /** Local upload whose script text matches no cloud version. */
    localModified: boolean('local_modified').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    leasedAt: ts('leased_at'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('runs_project_idx').on(t.projectId, t.createdAt),
    index('runs_queue_idx').on(t.status, t.createdAt),
    index('runs_parent_idx').on(t.parentRunId, t.orderIndex),
    index('runs_results_idx').on(t.resultFiles, t.finishedAt),
    index('runs_schedule_idx').on(t.scheduleId, t.status),
    // At most one retry per attempt.
    uniqueIndex('runs_retry_of_uq').on(t.retryOfRunId).where(sql`${t.retryOfRunId} is not null`),
  ],
);

// ── Schedules (ADR-020 §3) ───────────────────────────────────────────────────

export const schedules = pgTable(
  'schedules',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** script · suite */
    kind: text('kind').notNull(),
    scriptId: text('script_id').references(() => scripts.id, { onDelete: 'set null' }),
    suiteId: text('suite_id').references(() => suites.id, { onDelete: 'set null' }),
    environmentId: text('environment_id').references(() => environments.id, { onDelete: 'set null' }),
    /** Preset or raw cron as entered (UI round-trip). */
    cadence: jsonb('cadence').$type<Record<string, unknown>>().notNull(),
    /** 5-field cron evaluated in `timezone`. */
    cron: text('cron').notNull(),
    timezone: text('timezone').notNull().default('Asia/Seoul'),
    /** Shortest gap between occurrences (seconds) — the duration warning compares against it. */
    intervalSec: integer('interval_sec').notNull(),
    /** null → project default at fire time. */
    timeLimitSec: integer('time_limit_sec'),
    retryOnFailure: boolean('retry_on_failure').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    /** project_trashed — set when the server turned the schedule off. */
    disabledReason: text('disabled_reason'),
    nextRunAt: ts('next_run_at'),
    lastFiredAt: ts('last_fired_at'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    /** Creator name at creation — the run actor stays "예약 — <name>" after the creator leaves. */
    createdByLabel: text('created_by_label').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('schedules_project_idx').on(t.projectId), index('schedules_due_idx').on(t.enabled, t.nextRunAt)],
);

// ── Notifications (Teams outbox) · app notification events ───────────────────

/** One Teams webhook delivery (outbox — decided in the run's terminal transaction, sent after commit). */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => runs.id, { onDelete: 'cascade' }),
    /** failure · recovery · passed · flaky · skipped · aborted */
    kind: text('kind').notNull(),
    channel: text('channel').notNull().default('teams'),
    /** Request body snapshot (Adaptive Card envelope — no credential values, screenshots or HAR). */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** pending · sent · failed */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    sentAt: ts('sent_at'),
  },
  (t) => [index('notifications_pending_idx').on(t.status, t.nextAttemptAt), index('notifications_project_idx').on(t.projectId, t.createdAt)],
);

/**
 * Per-recipient app notification events (`GET /api/me/events`). `id` is the SSE event id; inserts
 * are serialized with an advisory lock so ids become visible in increasing order (resume-safe).
 */
export const userEvents = pgTable(
  'user_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('user_events_user_idx').on(t.userId, t.id), index('user_events_at_idx').on(t.at)],
);

/**
 * Access requests (stage 15 권한 요청): one open request per user per project (partial unique index),
 * open requests expire 30 days after `created_at` (read as expired; swept by purge).
 */
export const accessRequests = pgTable(
  'access_requests',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** editor · runner */
    role: text('role').notNull(),
    memo: text('memo').notNull().default(''),
    /** open · approved · rejected · expired */
    status: text('status').notNull().default('open'),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    decidedAt: ts('decided_at'),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    grantedRole: text('granted_role'),
  },
  (t) => [
    uniqueIndex('access_requests_open_uq').on(t.projectId, t.userId).where(sql`status = 'open'`),
    index('access_requests_project_idx').on(t.projectId, t.status),
    index('access_requests_user_idx').on(t.userId),
  ],
);

/**
 * App releases (stage 17 앱 배포 · 업데이트): one row per app version. Files live on the server volume
 * at `<UPDATES_DIR>/<channel>/<version>/<name>`; `/updates/<channel>/<name>` serves the newest
 * published release that has that file, so publishing (status + published_at, one UPDATE) switches
 * every `latest*.yml` at once. Only the newest 3 published per channel are kept.
 */
export const appReleases = pgTable(
  'app_releases',
  {
    id: id(),
    /** SemVer, unique across channels (the channel is derived from it). */
    version: text('version').notNull(),
    /** prerelease name (`alpha` · `beta`) or `stable`. */
    channel: text('channel').notNull(),
    notes: text('notes').notNull().default(''),
    /** draft · published */
    status: text('status').notNull().default('draft'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: ts('created_at').notNull().defaultNow(),
    publishedAt: ts('published_at'),
  },
  (t) => [uniqueIndex('app_releases_version_uq').on(t.version), index('app_releases_channel_idx').on(t.channel, t.status, t.publishedAt)],
);

export const appReleaseFiles = pgTable(
  'app_release_files',
  {
    releaseId: text('release_id')
      .notNull()
      .references(() => appReleases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    /** base64 SHA-512 (same encoding as electron-builder's latest*.yml). */
    sha512: text('sha512').notNull(),
    uploadedAt: ts('uploaded_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.releaseId, t.name] })],
);

/** Better Auth Drizzle adapter schema map (model name → table). */
export const authSchema = {
  user: users,
  session: sessions,
  account: accounts,
  verification: verifications,
  apikey: apikeys,
  deviceCode: deviceCodes,
};
