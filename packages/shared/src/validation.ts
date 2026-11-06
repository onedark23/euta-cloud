// Request validation schemas shared by server and web (zod 4, same family as the engine DSL).
import * as z from 'zod';
import { MEMBER_ROLES, TOKEN_PERMISSIONS } from './permissions.js';

/** Variable keys (SPEC 환경 "변수"). */
export const VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Credential-looking variable names are rejected — store them as test credentials instead.
 * Same rule as euta-app ADR-016 (`SENSITIVE_KEY` in euta-app src/main/project/project-store.ts).
 */
export const SENSITIVE_KEY = /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|COOKIE|AUTH)/i;
/** Test credential names = `${secrets.NAME}` keys. */
export const CREDENTIAL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const CREDENTIAL_VALUE_MAX_BYTES = 16 * 1024;
export const SCRIPT_MAX_BYTES = 256 * 1024;
export const SCRIPT_PATH_MAX = 500;
export const TOKEN_EXPIRY_DAYS = [30, 90, 180, 365] as const;
export const TOKEN_DEFAULT_EXPIRY_DAYS = 90;
export const MAX_ACTIVE_TOKENS = 10;
export const TOKEN_PREFIX = 'euta_';
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
export const TRASH_RETENTION_DAYS = 30;
export const SCRIPT_VERSIONS_KEPT = 200;
/** Run time limit (SPEC 실행 요청): project default 6 h, at most 24 h. */
export const RUN_DEFAULT_TIME_LIMIT_SEC = 6 * 3600;
export const RUN_MAX_TIME_LIMIT_SEC = 24 * 3600;
export const RUN_MIN_TIME_LIMIT_SEC = 60;
/** Per-project daily run cap (PLAN 결정 "실사용 부작용"): script runs per Asia/Seoul calendar day. */
export const DAILY_RUN_CAP_DEFAULT = 50;
export const DAILY_RUN_CAP_MAX = 10000;
export const BROWSER_ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export const SCRIPT_ORIGINS = ['web', 'app', 'ai_mcp', 'external', 'revert'] as const;
export type ScriptOrigin = (typeof SCRIPT_ORIGINS)[number];
/** Origins a client may claim on save (`revert` is set by the revert endpoint only). */
export const CLIENT_SCRIPT_ORIGINS = ['web', 'app', 'ai_mcp', 'external'] as const;

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

/** Returns an error message, or null when the path is acceptable (SPEC 스크립트 "경로"). */
export function scriptPathError(path: string): string | null {
  if (typeof path !== 'string' || !path) return 'script path is required';
  if (path.length > SCRIPT_PATH_MAX) return `script path is longer than ${SCRIPT_PATH_MAX} characters`;
  if (!noControl(path)) return 'script path contains control characters';
  if (path.includes('\\')) return 'use "/" as the path separator';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return 'script path must be relative to the project';
  const segs = path.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return 'script path must not contain empty, "." or ".." segments';
  if (segs.some((s) => s.startsWith('.'))) return 'script path segments must not start with "."';
  if (!/\.ya?ml$/i.test(path)) return 'script path must end in .yaml or .yml';
  return null;
}

export const scriptPathSchema = z.string().superRefine((v, ctx) => {
  const e = scriptPathError(v);
  if (e) ctx.addIssue({ code: 'custom', message: e });
});

/** Returns an error message for an environment base URL, or null. */
export function baseUrlError(v: string): string | null {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return 'base URL must be an absolute http(s) URL';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'base URL must be an absolute http(s) URL';
  if (u.username || u.password) return 'do not put credentials in the base URL — use test credentials';
  return null;
}

const hostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, 'invalid domain name');

export const varsSchema = z.record(z.string(), z.string().max(4000)).superRefine((vars, ctx) => {
  for (const k of Object.keys(vars)) {
    if (!VAR_KEY.test(k) || k.length > 64) ctx.addIssue({ code: 'custom', path: [k], message: `invalid variable name: ${k}` });
    else if (SENSITIVE_KEY.test(k)) {
      ctx.addIssue({ code: 'custom', path: [k], message: `"${k}" looks like a credential — store it as a test credential, not a variable` });
    }
  }
  if (Object.keys(vars).length > 200) ctx.addIssue({ code: 'custom', message: 'too many variables (max 200)' });
});

export const browserSchema = z.object({
  engine: z.enum(BROWSER_ENGINES).default('chromium'),
  device: trimmed(1, 80).optional(),
});

const webhookUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:';
    } catch {
      return false;
    }
  }, 'webhook URL must be an https URL');

export const projectCreateSchema = z.object({
  name: trimmed(1, 80).refine(noControl, 'name contains control characters'),
  description: z.string().trim().max(500).optional(),
  browser: browserSchema.optional(),
  testRules: z.string().max(2000).optional(),
  teamsWebhookUrl: webhookUrl.nullable().optional(),
});

/**
 * Notification toggles for outcomes that are off by default (SPEC 알림 "기본 끔"). Failure-class and
 * recovery notifications are always on.
 */
export const notifySettingsSchema = z.object({
  skipped: z.boolean(),
  aborted: z.boolean(),
  passed: z.boolean(),
  flaky: z.boolean(),
});
export type NotifySettings = z.output<typeof notifySettingsSchema>;
export const NOTIFY_DEFAULTS: NotifySettings = { skipped: false, aborted: false, passed: false, flaky: false };

export const projectUpdateSchema = projectCreateSchema.partial().extend({
  notify: notifySettingsSchema.partial().optional(),
  /** Script runs per Asia/Seoul day (scheduled, requested, MCP, retries; not local uploads or skipped). */
  dailyRunCap: z.number().int().min(1).max(DAILY_RUN_CAP_MAX).optional(),
  defaultEnvironmentId: z.string().min(1).nullable().optional(),
  /** Default run time limit for this project (seconds). */
  runTimeLimitSec: z.number().int().min(RUN_MIN_TIME_LIMIT_SEC).max(RUN_MAX_TIME_LIMIT_SEC).optional(),
});

export const projectDeleteSchema = z.object({ confirmName: z.string() });

export const memberPutSchema = z.object({ role: z.enum(MEMBER_ROLES) });

export const environmentCreateSchema = z.object({
  name: trimmed(1, 40).refine(noControl, 'name contains control characters'),
  baseUrl: z
    .string()
    .trim()
    .max(2000)
    .superRefine((v, ctx) => {
      const e = baseUrlError(v);
      if (e) ctx.addIssue({ code: 'custom', message: e });
    }),
  vars: varsSchema.default({}),
  /** Defaults to the base URL's host. */
  allowedDomains: z.array(hostname).max(50).optional(),
  makeDefault: z.boolean().optional(),
});

export const environmentUpdateSchema = environmentCreateSchema.partial();

export const credentialNameSchema = z.string().regex(CREDENTIAL_NAME, 'credential name must match [A-Za-z_][A-Za-z0-9_]{0,63}');

export const credentialPutSchema = z.object({
  value: z
    .string()
    .min(1)
    .refine((v) => new TextEncoder().encode(v).length <= CREDENTIAL_VALUE_MAX_BYTES, `value must be at most ${CREDENTIAL_VALUE_MAX_BYTES} bytes`),
});

export const scriptPutSchema = z.object({
  source: z.string(),
  /** The version the edit started from; null/omitted for a new script. */
  baseVersion: z.number().int().positive().nullable().optional(),
  origin: z.enum(CLIENT_SCRIPT_ORIGINS).default('web'),
  memo: z.string().trim().max(200).optional(),
});

export const scriptRenameSchema = z.object({ newPath: scriptPathSchema });
export const scriptRevertSchema = z.object({
  version: z.number().int().positive(),
  baseVersion: z.number().int().positive().optional(),
  memo: z.string().trim().max(200).optional(),
});

/**
 * `POST /api/projects/:id/scripts/check` — validate a script text, or apply a form edit to a base text
 * first (engine `rewriteScript`, comments kept). Used by the web editor (live validation, YAML → steps).
 */
const stepEditSchema: z.ZodType<{ src?: (string | number)[]; step: Record<string, unknown>; children?: unknown[] }> = z.lazy(() =>
  z.object({
    src: z.array(z.union([z.string(), z.number()])).max(50).optional(),
    step: z.record(z.string(), z.unknown()),
    children: z.array(stepEditSchema).max(1000).optional(),
  }),
);
export const scriptCheckSchema = z
  .object({
    /** Check this text as is. */
    source: z.string().max(SCRIPT_MAX_BYTES * 4).optional(),
    /** Base text the edit applies to (with `edit`). */
    base: z.string().max(SCRIPT_MAX_BYTES * 4).optional(),
    edit: z.object({ header: z.record(z.string(), z.unknown()), steps: z.array(stepEditSchema).max(1000) }).optional(),
    /** Report `${secrets.*}` names missing from this environment's test credentials. */
    environmentId: z.string().min(1).optional(),
  })
  .refine((b) => (b.source !== undefined) !== (b.edit !== undefined && b.base !== undefined), { message: 'give either source, or base + edit', path: ['source'] });

const suiteFields = {
  name: trimmed(1, 80).refine(noControl, 'name contains control characters'),
  scriptIds: z.array(z.string().min(1)).max(200),
  /** "항상 실행" script ids — each must be in scriptIds (ADR-031). */
  alwaysRun: z.array(z.string().min(1)).max(200),
  defaultEnvironmentId: z.string().min(1).nullable().optional(),
};
export const suiteCreateSchema = z.object({ ...suiteFields, scriptIds: suiteFields.scriptIds.default([]), alwaysRun: suiteFields.alwaysRun.default([]) });
/** No defaults here: `.partial()` of a defaulted field would fill it in (a PATCH of the name alone emptied the list). */
export const suiteUpdateSchema = z.object(suiteFields).partial();

export const tokenCreateSchema = z.object({
  name: trimmed(1, 40).refine(noControl, 'name contains control characters'),
  permission: z.enum(TOKEN_PERMISSIONS),
  expiresInDays: z
    .number()
    .int()
    .refine((d) => (TOKEN_EXPIRY_DAYS as readonly number[]).includes(d), `expiresInDays must be one of ${TOKEN_EXPIRY_DAYS.join(', ')}`)
    .default(TOKEN_DEFAULT_EXPIRY_DAYS),
});

/** Org user search (invite picker): `GET /api/users?q=` — name/email prefix, at most 20 results. */
export const USER_SEARCH_LIMIT = 20;
export const userSearchQuerySchema = z.object({ q: z.string().trim().max(100).optional() });

export const activityQuerySchema = z.object({
  kind: z.string().max(60).optional(),
  actor: z.string().max(100).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
