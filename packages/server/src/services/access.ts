// Who is calling (session cookie / bearer session token / personal token) and what they may do.
// All project permission checks go through `projectAccess` → shared `decide()`.
import { allowedActions, decide, type ProjectAction, type ProjectRole, type TokenPermission, type UserStatus } from '@euta-cloud/shared';
import { fromNodeHeaders } from 'better-auth/node';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { projectMembers, projects, users } from '../db/schema.js';
import { AppError, forbidden, notFound, unauthenticated } from '../http.js';

export interface Principal {
  user: { id: string; email: string; name: string; emailVerified: boolean; status: UserStatus; isAdmin: boolean };
  via: 'session' | 'token';
  tokenPermission?: TokenPermission;
  tokenId?: string;
  tokenName?: string;
}

export interface Actor {
  type: 'user' | 'ai' | 'schedule' | 'system';
  id: string | null;
  label: string;
}

export function actorOf(p: Principal): Actor {
  if (p.via === 'token') return { type: 'ai', id: p.user.id, label: `AI — ${p.user.name} (${p.tokenName ?? 'token'})` };
  return { type: 'user', id: p.user.id, label: p.user.name };
}

function tokenPermissionOf(raw: unknown): TokenPermission {
  try {
    const perms = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { project?: string[] } | null;
    return perms?.project?.includes('write') ? 'read_write' : 'read';
  } catch {
    return 'read';
  }
}

async function loadUser(ctx: AppContext, id: string): Promise<Principal['user'] | null> {
  const [u] = await ctx.db
    .select({ id: users.id, email: users.email, name: users.name, emailVerified: users.emailVerified, status: users.status, isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, id));
  return u ? { ...u, status: u.status as UserStatus } : null;
}

/** Resolve the caller, or null when unauthenticated. Inactive accounts are treated as unauthenticated. */
export async function authenticate(ctx: AppContext, req: FastifyRequest): Promise<Principal | null> {
  const authz = req.headers.authorization;
  const bearer = typeof authz === 'string' && /^Bearer\s+/i.test(authz) ? authz.replace(/^Bearer\s+/i, '').trim() : null;
  if (bearer?.startsWith('euta_')) {
    const r = await ctx.auth.api.verifyApiKey({ body: { key: bearer } });
    if (!r.valid || !r.key) {
      const code = r.error?.code === 'RATE_LIMITED' || r.error?.code === 'USAGE_EXCEEDED' ? r.error.code : null;
      if (code) throw new AppError(429, 'RATE_LIMITED', 'too many requests for this token');
      throw unauthenticated('invalid, expired or revoked token');
    }
    const user = await loadUser(ctx, r.key.referenceId);
    if (!user || user.status !== 'active') throw unauthenticated('account is not active');
    return { user, via: 'token', tokenPermission: tokenPermissionOf(r.key.permissions), tokenId: r.key.id, tokenName: r.key.name ?? undefined };
  }
  const session = await ctx.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return null;
  const user = await loadUser(ctx, session.user.id);
  if (!user || user.status !== 'active') return null;
  return { user, via: 'session' };
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthenticated();
  return req.principal;
}

/** Token management and admin endpoints need an interactive session (a token cannot mint tokens). */
export function requireSession(req: FastifyRequest): Principal {
  const p = requirePrincipal(req);
  if (p.via !== 'session') throw new AppError(403, 'FORBIDDEN', 'this endpoint needs a signed-in session, not a personal token');
  return p;
}

export function requireAdmin(req: FastifyRequest): Principal {
  const p = requireSession(req);
  if (!p.user.isAdmin) throw forbidden('administrator only');
  return p;
}

export type ProjectRow = typeof projects.$inferSelect;

export async function roleIn(ctx: AppContext, projectId: string, userId: string): Promise<ProjectRole> {
  return (await membershipIn(ctx, projectId, userId)).role;
}

/** The caller's role plus whether a project_members row exists (an invited viewer vs. an org viewer). */
export async function membershipIn(ctx: AppContext, projectId: string, userId: string): Promise<{ role: ProjectRole; isMember: boolean }> {
  const [m] = await ctx.db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  return m ? { role: m.role as ProjectRole, isMember: true } : { role: 'viewer', isMember: false };
}

/**
 * `can` for responses: the role table, narrowed by context — leaving needs a member row, and asking
 * for access only makes sense below editor (requestable roles are editor/runner).
 */
export function canFor(role: ProjectRole, isMember: boolean, tokenPermission?: TokenPermission): ProjectAction[] {
  return allowedActions({ role, tokenPermission }).filter((a) => (a === 'member.leave' ? isMember : a === 'access.request' ? role === 'viewer' || role === 'runner' : true));
}

export interface ProjectAccess {
  project: ProjectRow;
  role: ProjectRole;
  isMember: boolean;
  /** Name of the birth-record creator (null when the account is gone). */
  creatorName: string | null;
  principal: Principal;
}

/**
 * Load a project and check `action` for the caller. Trashed projects are 404 unless
 * `includeTrashed` (restore). A members-only project is 404 for non-members, whatever the action
 * (stage 15 공개 범위). Permission = decide(role, action, token permission).
 */
export async function projectAccess(
  ctx: AppContext,
  req: FastifyRequest,
  projectId: string,
  action: ProjectAction,
  opts: { includeTrashed?: boolean } = {},
): Promise<ProjectAccess> {
  return projectAccessFor(ctx, requirePrincipal(req), projectId, action, opts);
}

/** `projectAccess` for an already-resolved principal (remote MCP tools). */
export async function projectAccessFor(
  ctx: AppContext,
  principal: Principal,
  projectId: string,
  action: ProjectAction,
  opts: { includeTrashed?: boolean } = {},
): Promise<ProjectAccess> {
  const [row] = await ctx.db.select({ project: projects, creatorName: users.name }).from(projects).leftJoin(users, eq(users.id, projects.createdBy)).where(eq(projects.id, projectId));
  const project = row?.project;
  if (!project || (project.deletedAt && !opts.includeTrashed)) throw notFound('project');
  const { role, isMember } = await membershipIn(ctx, projectId, principal.user.id);
  if (project.visibility === 'members' && !isMember) throw notFound('project');
  const ok = decide({ role, action, tokenPermission: principal.tokenPermission, active: principal.user.status === 'active' });
  if (!ok) {
    // Trashed projects stay invisible to anyone who couldn't restore them.
    if (project.deletedAt) throw notFound('project');
    throw forbidden();
  }
  return { project, role, isMember, creatorName: row!.creatorName ?? null, principal };
}
