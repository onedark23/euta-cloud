// Stage 15 "한 프로젝트 + 권한": birth record, visibility, access requests, leave/transfer, merge,
// receive list (SPEC_클라우드-계정-프로젝트 "만들기·공개·구성원", SPEC_클라우드-앱-연동 "프로젝트 종류").
import * as z from 'zod';
import { MEMBER_ROLES, PROJECT_VISIBILITIES, REQUESTABLE_ROLES, type ProjectOrigin, type ProjectRole, type ProjectVisibility, type RequestableRole } from './permissions.js';
import { projectCreateSchema } from './validation.js';

/** Open access requests expire after this many days (SPEC 권한 요청). */
export const ACCESS_REQUEST_EXPIRY_DAYS = 30;
export const ACCESS_REQUEST_MEMO_MAX = 200;

const localId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/, 'local project id: letters, digits, - and _');

/** `POST /api/projects` body: the create fields + who is creating it (web "새 프로젝트" / app "클라우드로 올리기"). */
export const projectCreateBodySchema = projectCreateSchema
  .extend({
    origin: z.enum(['web', 'app']).default('web'),
    originLocalId: localId.optional(),
  })
  .refine((b) => (b.origin === 'app') === (b.originLocalId !== undefined), { message: 'originLocalId is required for origin "app" (and only then)', path: ['originLocalId'] });

export const visibilityPutSchema = z.object({ visibility: z.enum(PROJECT_VISIBILITIES) });

export const accessRequestCreateSchema = z.object({
  role: z.enum(REQUESTABLE_ROLES),
  memo: z.string().trim().max(ACCESS_REQUEST_MEMO_MAX).optional(),
});
export const accessRequestApproveSchema = z.object({ role: z.enum(MEMBER_ROLES).optional() });
export const accessRequestListQuerySchema = z.object({ status: z.enum(['open', 'approved', 'rejected', 'expired']).optional() });

export const transferSchema = z.object({
  userId: z.string().min(1),
  /** What happens to me after the target becomes an owner. */
  myRole: z.enum(['editor', 'runner', 'viewer', 'leave']),
});

export const adminAssignOwnerSchema = z.object({ userId: z.string().min(1) });

export const mergeSchema = z.object({
  /** The local project being merged (the one carrying the old `uploadedTo` link). */
  localProjectId: localId,
  /** The local link record as stored by the copy-style upload (`project.json.uploadedTo`) — required for `unknown` projects. */
  uploadedTo: z.object({ projectId: z.string().min(1), localId: z.string().min(1).max(200) }).optional(),
  summary: z
    .object({
      scriptsUploaded: z.number().int().min(0),
      scriptsChosen: z.number().int().min(0),
      suitesUploaded: z.number().int().min(0),
      environmentsUploaded: z.number().int().min(0),
      runsMoved: z.number().int().min(0),
    })
    .partial()
    .optional(),
});

export type AccessRequestStatus = 'open' | 'approved' | 'rejected' | 'expired';

export interface UserRefDto {
  id: string;
  name: string;
}

export interface BirthRecordDto {
  origin: ProjectOrigin;
  originLocalId: string | null;
  createdBy: UserRefDto | null;
  createdAt: string;
}

export interface AccessRequestDto {
  id: string;
  projectId: string;
  projectName: string;
  user: { id: string; name: string; email: string };
  role: RequestableRole;
  memo: string;
  status: AccessRequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: UserRefDto | null;
  grantedRole: ProjectRole | null;
}

export interface ReceivableProjectDto {
  id: string;
  name: string;
  description: string;
  createdBy: UserRefDto | null;
  origin: ProjectOrigin;
  originLocalId: string | null;
  visibility: ProjectVisibility;
  myRole: ProjectRole;
  lastRun: { id: string; status: string; flaky: boolean; queuedAt: string; finishedAt: string | null } | null;
  canRequestAccess: boolean;
  openRequest: { id: string; role: RequestableRole; createdAt: string; expiresAt: string } | null;
}

/** `GET /api/admin/projects/ownerless` — projects whose owners are all deactivated (name and people only, no content). */
export interface OwnerlessProjectDto {
  id: string;
  name: string;
  visibility: ProjectVisibility;
  createdAt: string;
  owners: { id: string; name: string; email: string; status: string }[];
  members: { id: string; name: string; email: string; role: ProjectRole }[];
}

/** `GET /api/me/events` notifications added in stage 15 (data differs from run notifications). */
export type AccessUserEventDto =
  | { id: number; kind: 'access.requested'; at: string; projectId: string; runId: null; data: { projectName: string; requestId: string; requester: UserRefDto; role: RequestableRole; memo: string } }
  | { id: number; kind: 'access.approved'; at: string; projectId: string; runId: null; data: { projectName: string; requestId: string; role: RequestableRole; grantedRole: ProjectRole } }
  | { id: number; kind: 'access.rejected'; at: string; projectId: string; runId: null; data: { projectName: string; requestId: string; role: RequestableRole } };
