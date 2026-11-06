// Project permission decision — the single source of truth for "who may do what" (ARCH 인증·권한).
// Server routes call `decide()` for every project-scoped request; web/app use the same table to
// hide buttons. Better Auth only answers "who is this"; roles live here.

export const PROJECT_ROLES = ['owner', 'editor', 'runner', 'viewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];
/**
 * Roles that are stored in project_members (all four — a members-only project invites viewers too).
 * Non-members of an org-visible project are viewers.
 */
export const MEMBER_ROLES = PROJECT_ROLES;
/** Roles one may ask for in an access request (SPEC 권한 요청). */
export const REQUESTABLE_ROLES = ['editor', 'runner'] as const;
export type RequestableRole = (typeof REQUESTABLE_ROLES)[number];
/** Higher = more rights (owner > editor > runner > viewer). */
export const ROLE_RANK: Record<ProjectRole, number> = { owner: 3, editor: 2, runner: 1, viewer: 0 };

/** Project visibility (SPEC 공개 범위): `org` = every org member sees it as viewer, `members` = invited only. */
export const PROJECT_VISIBILITIES = ['org', 'members'] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];
/** Birth record origin: web "새 프로젝트" · app "클라우드로 올리기" · unknown (before stage 15). */
export const PROJECT_ORIGINS = ['web', 'app', 'unknown'] as const;
export type ProjectOrigin = (typeof PROJECT_ORIGINS)[number];
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Personal token permission (SPEC 개인 토큰): `read` or `read_write`. */
export const TOKEN_PERMISSIONS = ['read', 'read_write'] as const;
export type TokenPermission = (typeof TOKEN_PERMISSIONS)[number];

/**
 * The role table (ARCH 권한 표). Each action lists the roles allowed to perform it.
 * `project.update` (name · description · browser · test rules · webhook · default env) is not
 * in the ARCH table; it sits with environment editing → editor+ (SPEC Change Log 2026-10-20).
 */
export const ROLE_TABLE = {
  /** 현황·이력·리포트·설정·스크립트·작업 로그 보기 */
  'project.view': ['owner', 'editor', 'runner', 'viewer'],
  /** 실행 · 테스트 세트 실행 · 실행 취소 */
  'run.execute': ['owner', 'editor', 'runner'],
  /** 예약 */
  'schedule.manage': ['owner', 'editor'],
  /** 스크립트 저장·이름 변경·삭제·복원·되돌리기 */
  'script.edit': ['owner', 'editor'],
  /** 테스트 세트 편집 */
  'suite.edit': ['owner', 'editor'],
  /** 환경(주소·변수·허용 도메인) 편집 */
  'environment.edit': ['owner', 'editor'],
  /** 테스트 계정 입력·삭제 (값은 아무도 다시 못 봄) */
  'credential.write': ['owner', 'editor'],
  /** 로컬 실행 올리기 */
  'run.upload': ['owner', 'editor', 'runner'],
  /** 프로젝트 기본 정보·알림·테스트 규칙 편집 */
  'project.update': ['owner', 'editor'],
  /** 구성원 초대 · 역할 변경 · 내보내기 · 권한 요청 승인/거절 */
  'member.manage': ['owner'],
  /** 공개 범위 변경 */
  'project.visibility': ['owner'],
  /** 소유권 이전 */
  'project.transfer': ['owner'],
  /** 갈라진 로컬 프로젝트 합치기 (출생 기록 검사는 따로) */
  'project.merge': ['owner'],
  /** 권한 요청 (지금 역할보다 높은 역할만 — 서버가 따로 검사) */
  'access.request': ['editor', 'runner', 'viewer'],
  /** 나가기 (구성원 행이 있어야 하고, 마지막 소유자는 불가 — 서버가 따로 검사) */
  'member.leave': ['owner', 'editor', 'runner', 'viewer'],
  /** 프로젝트 삭제(휴지통) */
  'project.delete': ['owner'],
  /** 휴지통에서 복원 */
  'project.restore': ['owner'],
} as const satisfies Record<string, readonly ProjectRole[]>;

export type ProjectAction = keyof typeof ROLE_TABLE;
export const PROJECT_ACTIONS = Object.keys(ROLE_TABLE) as ProjectAction[];

/** Actions a `read` token may perform (everything else needs `read_write`). */
export const READ_ONLY_ACTIONS: ReadonlySet<ProjectAction> = new Set<ProjectAction>(['project.view']);

export interface DecideInput {
  /** The caller's project role (non-members are `viewer`). */
  role: ProjectRole;
  action: ProjectAction;
  /** Set when the request is authenticated with a personal token. */
  tokenPermission?: TokenPermission;
  /** Deactivated / pending accounts are excluded from every permission check. */
  active?: boolean;
}

/**
 * Effective permission = min(token permission, project role): a `read` token can only perform
 * read actions whatever the role; a `read_write` token is bounded by the role.
 */
export function decide(input: DecideInput): boolean {
  if (input.active === false) return false;
  if (input.tokenPermission === 'read' && !READ_ONLY_ACTIONS.has(input.action)) return false;
  return (ROLE_TABLE[input.action] as readonly ProjectRole[]).includes(input.role);
}

/** The role a token-authenticated caller effectively has (for UI hints / API responses). */
export function effectiveRole(role: ProjectRole, tokenPermission?: TokenPermission): ProjectRole {
  return tokenPermission === 'read' ? 'viewer' : role;
}

/** Every action the caller may perform — handy for `GET /api/projects/:id` → `can`. */
export function allowedActions(input: Omit<DecideInput, 'action'>): ProjectAction[] {
  return PROJECT_ACTIONS.filter((action) => decide({ ...input, action }));
}
