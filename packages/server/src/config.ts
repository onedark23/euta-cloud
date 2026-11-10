// Server configuration from environment variables (k8s: ConfigMap + Secret). No secrets in the repo.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

export interface Config {
  databaseUrl: string;
  /** Public base URL of this server (cookies, mail links, device verification URI). */
  baseUrl: string;
  host: string;
  port: number;
  /** Better Auth secret (session signing). */
  authSecret: string;
  /** 32-byte AES-256-GCM key for test credentials. */
  credentialsKey: Buffer;
  allowedEmailDomains: string[];
  adminEmails: string[];
  /** Microsoft (Entra ID) login, company tenant only. null → email sign-up (the previous mode). */
  microsoft: MicrosoftConfig | null;
  /** SMTP connection URL (e.g. smtp://mailpit:1025). Unset → admin-approval sign-up mode. */
  smtpUrl: string | null;
  mailFrom: string;
  /** Better Auth's built-in endpoint rate limiter. */
  rateLimit: boolean;
  /** Directory with the built web UI; null → placeholder page. */
  webDist: string | null;
  /** OAuth client ids allowed to use the device authorization flow. */
  deviceClientIds: string[];
  /** Change feed retention (days). Older events are purged; clients older than that get a resync signal. */
  feedRetentionDays: number;
  logLevel: string;
  /** Internal runner API port (`/internal/*`) — a separate listener, never behind the public ingress. */
  internalPort: number;
  /** Shared runner token (k8s Secret). Unset → the internal API refuses every request. */
  runnerToken: string | null;
  /**
   * DEV/TEST ONLY. Skips the public-address precheck so a run can target 127.0.0.1 / host.docker.internal
   * (engine fixture site). Never set this in a deployed environment.
   */
  allowPrivateTargets: boolean;
  /** Result file root (server PVC): `<root>/<projectId>/<runId>/…`, baselines `<root>/<projectId>/baselines/…`. */
  resultsDir: string;
  resultRetentionDays: number;
  /** Total result file cap; above it the oldest runs' files are deleted first. */
  resultMaxTotalBytes: number;
  /** Per-run upload cap (tar body). */
  resultMaxRunBytes: number;
  /** Runner lease length; the runner renews it with every events call. */
  leaseTtlMs: number;
  /** How often the runner should call `events` even with nothing to send (lease renewal + stop signal). */
  runnerHeartbeatMs: number;
  /** App update files (stage 17): `<root>/<channel>/<version>/<file>`. Separate from the result cap. */
  updatesDir: string;
  /** Oldest app version allowed on device-token requests (426 APP_TOO_OLD below it). null → no check. */
  minAppVersion: string | null;
  /** GitHub release mirror (ADR-048 decision 2). null → off (APP_MIRROR_GITHUB unset/empty). */
  appMirror: AppMirrorConfig | null;
}

export interface AppMirrorConfig {
  /** `<owner>/<repo>` whose latest release is imported. */
  repo: string;
  /** Time between sync runs (the first run is 1 minute after start). */
  intervalMs: number;
  /** `https://github.com` — overridable for tests only (fake GitHub). */
  baseUrl: string;
}

export interface MicrosoftConfig {
  /** Company tenant id — never "common"/"organizations": other tenants could assert any email. */
  tenantId: string;
  clientId: string;
  clientSecret: string;
}

const MULTI_TENANT = ['common', 'organizations', 'consumers'];

/** All three of MICROSOFT_TENANT_ID / _CLIENT_ID / _CLIENT_SECRET, or none. */
export function parseMicrosoft(env: NodeJS.ProcessEnv): MicrosoftConfig | null {
  const tenantId = env.MICROSOFT_TENANT_ID || '';
  const clientId = env.MICROSOFT_CLIENT_ID || '';
  const clientSecret = env.MICROSOFT_CLIENT_SECRET || '';
  if (!tenantId && !clientId && !clientSecret) return null;
  if (!tenantId || !clientId || !clientSecret) throw new Error('MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be set together');
  if (MULTI_TENANT.includes(tenantId.toLowerCase())) throw new Error('MICROSOFT_TENANT_ID must be the company tenant id, not a multi-tenant alias');
  return { tenantId, clientId, clientSecret };
}

const UNITS: Record<string, number> = { '': 1, k: 1e3, m: 1e6, g: 1e9, t: 1e12, ki: 1024, mi: 1024 ** 2, gi: 1024 ** 3, ti: 1024 ** 4 };

/** "12Gi" · "500Mi" · "2G" · "1048576" → bytes. */
export function parseBytes(v: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]i?)?b?\s*$/i.exec(v);
  if (!m) throw new Error(`invalid byte size: ${v}`);
  return Math.floor(Number(m[1]) * UNITS[(m[2] ?? '').toLowerCase()]!);
}

const list = (v: string | undefined, fallback: string[] = []): string[] =>
  v === undefined ? fallback : v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`missing required environment variable ${key}`);
  return v;
}

export function parseCredentialsKey(v: string): Buffer {
  const key = Buffer.from(v, 'base64');
  if (key.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  return key;
}

/** MIN_APP_VERSION: empty → null; otherwise a SemVer (prerelease allowed). */
export function parseMinAppVersion(v: string | undefined): string | null {
  const t = v?.trim();
  if (!t) return null;
  const valid = semver.valid(t);
  if (!valid) throw new Error(`MIN_APP_VERSION must be a SemVer version (e.g. 0.1.0-alpha.2): ${t}`);
  return valid;
}

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** "10m" · "30s" · "1h" · "500ms" → milliseconds. */
export function parseDuration(v: string, what: string): number {
  const m = /^\s*(\d+)\s*(ms|s|m|h)\s*$/.exec(v);
  if (!m) throw new Error(`${what} must be a duration such as 10m, 30s or 1h: ${v}`);
  return Number(m[1]) * DURATION_UNITS[m[2]!]!;
}

const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** Shortest allowed APP_MIRROR_INTERVAL — GitHub is polled anonymously. */
export const MIN_MIRROR_INTERVAL_MS = 60_000;

/** APP_MIRROR_GITHUB (`<owner>/<repo>`, empty → off) · APP_MIRROR_INTERVAL (default 10m) · APP_MIRROR_BASE_URL (tests). */
export function parseAppMirror(env: NodeJS.ProcessEnv): AppMirrorConfig | null {
  const repo = env.APP_MIRROR_GITHUB?.trim();
  if (!repo) return null;
  if (!GITHUB_REPO.test(repo) || repo.endsWith('/.') || repo.endsWith('/..')) {
    throw new Error(`APP_MIRROR_GITHUB must be <owner>/<repo> (e.g. onedark23/euta-app): ${repo}`);
  }
  const intervalMs = parseDuration(env.APP_MIRROR_INTERVAL?.trim() || '10m', 'APP_MIRROR_INTERVAL');
  if (intervalMs < MIN_MIRROR_INTERVAL_MS) throw new Error('APP_MIRROR_INTERVAL must be at least 1m');
  const baseUrl = (env.APP_MIRROR_BASE_URL?.trim() || 'https://github.com').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(baseUrl)) throw new Error(`APP_MIRROR_BASE_URL must be an http(s) URL: ${baseUrl}`);
  return { repo, intervalMs, baseUrl };
}

const DEFAULT_WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authSecret = required(env, 'BETTER_AUTH_SECRET');
  if (authSecret.length < 32) throw new Error('BETTER_AUTH_SECRET must be at least 32 characters');
  const webDist = env.WEB_DIST ?? DEFAULT_WEB_DIST;
  const smtpUrl = env.SMTP_URL || null;
  const adminEmails = list(env.ADMIN_EMAILS);
  // Approval mode without an administrator would leave every sign-up pending forever.
  if (!smtpUrl && !adminEmails.length) throw new Error('ADMIN_EMAILS is required when SMTP_URL is not set (admin-approval sign-up mode)');
  // Who may sign up is a deployment decision — no built-in default domain.
  const allowedEmailDomains = list(env.ALLOWED_EMAIL_DOMAINS);
  if (!allowedEmailDomains.length) throw new Error('ALLOWED_EMAIL_DOMAINS is required (comma-separated e-mail domains that may sign up, e.g. example.com)');
  const baseUrl = (env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    baseUrl,
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8080),
    authSecret,
    credentialsKey: parseCredentialsKey(required(env, 'CREDENTIALS_KEY')),
    allowedEmailDomains,
    adminEmails,
    microsoft: parseMicrosoft(env),
    smtpUrl,
    mailFrom: env.MAIL_FROM ?? `euta cloud <no-reply@${new URL(baseUrl).hostname}>`,
    rateLimit: (env.AUTH_RATE_LIMIT ?? 'true') !== 'false',
    webDist: existsSync(webDist) ? webDist : null,
    deviceClientIds: list(env.DEVICE_CLIENT_IDS, ['euta-app']),
    feedRetentionDays: Number(env.FEED_RETENTION_DAYS ?? 7),
    logLevel: env.LOG_LEVEL ?? 'info',
    internalPort: Number(env.INTERNAL_PORT ?? 8081),
    runnerToken: env.RUNNER_TOKEN || null,
    allowPrivateTargets: env.ALLOW_PRIVATE_TARGETS === 'true',
    resultsDir: resolve(env.RESULTS_DIR ?? 'data/results'),
    resultRetentionDays: Number(env.RESULT_RETENTION_DAYS ?? 30),
    resultMaxTotalBytes: parseBytes(env.RESULT_MAX_TOTAL ?? '12Gi'),
    resultMaxRunBytes: parseBytes(env.RESULT_MAX_RUN ?? '2Gi'),
    leaseTtlMs: Number(env.RUN_LEASE_TTL_MS ?? 120_000),
    runnerHeartbeatMs: Number(env.RUNNER_HEARTBEAT_MS ?? 5_000),
    updatesDir: resolve(env.UPDATES_DIR ?? 'data/updates'),
    minAppVersion: parseMinAppVersion(env.MIN_APP_VERSION),
    appMirror: parseAppMirror(env),
  };
}
