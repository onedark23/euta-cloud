// API response shapes (server → web/app).
import type { BirthRecordDto } from './access.js';
import type { MemberRole, ProjectAction, ProjectRole, ProjectVisibility, TokenPermission } from './permissions.js';
import type { ScriptOrigin } from './validation.js';

export type UserStatus = 'active' | 'pending' | 'deactivated';

/** `GET /api/config` (public): sign-up mode and allowed e-mail domains for the sign-up / login pages. */
export interface ServerConfigDto {
  /** `approval` = no SMTP, an administrator approves sign-ups (PoC mode); `email` = verification mail. */
  signUpMode: 'approval' | 'email';
  allowedEmailDomains: string[];
  /** Company Microsoft (Entra ID) login is on → the main way in; new email sign-ups are closed. */
  microsoftLogin: boolean;
  /**
   * This server distributes app updates (at least one published release) → apps connected to it update from
   * `/updates/<channel>/`, others from GitHub Releases (SPEC 앱-배포-업데이트 "업데이트 원본", ADR-047).
   */
  appUpdates: boolean;
}

export interface MeDto {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  status: UserStatus;
  isAdmin: boolean;
  auth: 'session' | 'token';
  tokenPermission?: TokenPermission;
}

export interface TokenDto {
  id: string;
  name: string;
  permission: TokenPermission;
  /** First characters incl. prefix, e.g. `euta_AbCd`. */
  start: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  expiringSoon: boolean;
}

export interface ProjectDto {
  id: string;
  name: string;
  description: string;
  browser: { engine: 'chromium' | 'firefox' | 'webkit'; device?: string };
  testRules: string;
  /**
   * Teams Workflows webhook URL (contains a SAS `sig`). Present only for callers who may change project
   * settings (editor+, read_write token); viewers / read tokens see `teamsWebhookConfigured` only.
   */
  teamsWebhookUrl?: string | null;
  teamsWebhookConfigured: boolean;
  defaultEnvironmentId: string | null;
  /** Default run time limit (seconds). */
  runTimeLimitSec: number;
  /** Off-by-default notification toggles (failure / recovery are always sent). */
  notify: { skipped: boolean; aborted: boolean; passed: boolean; flaky: boolean };
  /** Script runs allowed per Asia/Seoul calendar day. */
  dailyRunCap: number;
  /** Today's usage against the cap (single-project responses). */
  dailyRunUsage?: { day: string; used: number; cap: number };
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  myRole: ProjectRole;
  /** True when the caller has a project_members row (an invited viewer too). */
  isMember: boolean;
  can?: ProjectAction[];
  /** Stage 15: `org` (default) or `members` (invited only — others get 404). */
  visibility: ProjectVisibility;
  /** Immutable birth record (origin web/app/unknown, local project id for app). */
  birth: BirthRecordDto;
  /** `POST /api/projects` returned an existing app-born project for the same local id ("이어서 하기"). */
  resumed?: boolean;
  /** Latest top-level run (project list only). */
  lastRun?: { id: string; status: string; flaky: boolean; queuedAt: string; finishedAt: string | null } | null;
}

/** Org user search result (`GET /api/users`) — active users only, nothing beyond id/name/email. */
export interface UserSummaryDto {
  id: string;
  name: string;
  email: string;
}

export interface MemberDto {
  userId: string;
  email: string;
  name: string;
  role: MemberRole;
  active: boolean;
  addedAt: string;
}

export interface AddressCheck {
  public: boolean;
  reason?: string;
}

export interface EnvironmentDto {
  id: string;
  name: string;
  baseUrl: string;
  vars: Record<string, string>;
  allowedDomains: string[];
  /** False when the base URL host resolves to a private/internal address (cloud run not possible). */
  cloudRunnable: boolean;
  addressCheck: AddressCheck;
  isDefault: boolean;
  credentialNames: string[];
  updatedAt: string;
}

export interface CredentialDto {
  name: string;
  updatedAt: string;
  updatedBy: { id: string; name: string } | null;
}

export interface ValidationIssueDto {
  path: string;
  message: string;
}

export interface ScriptDto {
  id: string;
  path: string;
  /** YAML `name:` of the current version (null = none) — screens show it, the path small (SPEC 계정 "스크립트 표시"). */
  name: string | null;
  version: number;
  contentHash: string;
  validationOk: boolean;
  updatedAt: string;
  updatedBy: { id: string; name: string } | null;
  deletedAt?: string | null;
}

export interface ScriptVersionDto {
  version: number;
  contentHash: string;
  origin: ScriptOrigin;
  memo: string | null;
  author: { id: string; name: string } | null;
  createdAt: string;
  validation: { ok: boolean; issues: ValidationIssueDto[] };
  source?: string;
}

/** `POST /api/projects/:id/scripts/check` result. */
export interface ScriptCheckDto {
  /** The checked text (the rewritten text when an edit was given). */
  source: string;
  contentHash: string;
  /** Parsed script (a YAML mapping), or null when the text is not a mapping. */
  script: Record<string, unknown> | null;
  /** Save blockers (YAML, schema, references) — the same check the save runs. */
  validation: { parsed: boolean; ok: boolean; issues: ValidationIssueDto[] };
  /** Every `${secrets.NAME}` the script uses. */
  secretNames: string[];
  /** Names missing from the given environment's test credentials (empty without `environmentId`). */
  missingSecrets: string[];
  /** `${secrets.*}` outside fill/type values (warning — a cloud run refuses it). */
  ruleIssues: ValidationIssueDto[];
  /** `input: os` (warning — a cloud run refuses it). */
  osInputIssues: ValidationIssueDto[];
  /** CSS targets (fragile). */
  unstable: number;
}

export interface FeedEventDto {
  seq: number;
  kind: string;
  at: string;
  actorId: string | null;
  data: Record<string, unknown>;
}
