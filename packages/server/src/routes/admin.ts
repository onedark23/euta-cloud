// Admin (SPEC 계정): GET /api/admin/users · POST /api/admin/users/:id/(approve|deactivate|activate|reset-password)
import { randomBytes } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { apikeys, deviceCodes, sessions, users } from '../db/schema.js';
import { AppError, notFound } from '../http.js';
import { requireAdmin } from '../services/access.js';

export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    const rows = await ctx.db
      .select({ id: users.id, email: users.email, name: users.name, emailVerified: users.emailVerified, status: users.status, isAdmin: users.isAdmin, createdAt: users.createdAt })
      .from(users)
      .orderBy(asc(users.createdAt));
    return { users: rows.map((u) => ({ ...u, createdAt: u.createdAt.toISOString() })), approvalMode: ctx.approvalMode };
  });

  const target = async (id: string) => {
    const [u] = await ctx.db.select().from(users).where(eq(users.id, id));
    if (!u) throw notFound('user');
    return u;
  };

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/approve', async (req) => {
    requireAdmin(req);
    const u = await target(req.params.id);
    if (u.status !== 'pending') throw new AppError(409, 'CONFLICT', `user is ${u.status}, not pending`);
    // Approval replaces mail verification in approval mode.
    await ctx.db.update(users).set({ status: 'active', emailVerified: true, updatedAt: ctx.clock.now() }).where(eq(users.id, u.id));
    return { id: u.id, status: 'active' };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/deactivate', async (req) => {
    const admin = requireAdmin(req);
    const u = await target(req.params.id);
    if (u.id === admin.user.id) throw new AppError(409, 'CONFLICT', 'you cannot deactivate your own account');
    // Deactivation: no login, every session (web + device tokens) and personal token revoked.
    // Project roles stay but the account is excluded from permission checks (status ≠ active).
    await ctx.db.transaction(async (tx) => {
      await tx.update(users).set({ status: 'deactivated', updatedAt: ctx.clock.now() }).where(eq(users.id, u.id));
      await tx.delete(sessions).where(eq(sessions.userId, u.id));
      await tx.delete(apikeys).where(eq(apikeys.referenceId, u.id));
      await tx.delete(deviceCodes).where(eq(deviceCodes.userId, u.id));
    });
    return { id: u.id, status: 'deactivated' };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/activate', async (req) => {
    requireAdmin(req);
    const u = await target(req.params.id);
    if (u.status !== 'deactivated') throw new AppError(409, 'CONFLICT', `user is ${u.status}, not deactivated`);
    await ctx.db.update(users).set({ status: 'active', updatedAt: ctx.clock.now() }).where(eq(users.id, u.id));
    return { id: u.id, status: 'active' };
  });

  // Approval mode has no reset mail: the admin issues a one-time temporary password (SPEC 비밀번호 재설정).
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/reset-password', async (req) => {
    requireAdmin(req);
    if (!ctx.approvalMode) throw new AppError(409, 'CONFLICT', 'password reset goes through the reset mail when SMTP is configured');
    const u = await target(req.params.id);
    const temporaryPassword = randomBytes(12).toString('base64url');
    const authCtx = await ctx.auth.$context;
    await authCtx.internalAdapter.updatePassword(u.id, await authCtx.password.hash(temporaryPassword));
    await ctx.db.delete(sessions).where(eq(sessions.userId, u.id));
    return { id: u.id, temporaryPassword };
  });
}
