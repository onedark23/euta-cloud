// GET /api/me · personal tokens (SPEC 개인 토큰): GET/POST /api/me/tokens · DELETE /api/me/tokens/:id
import { MAX_ACTIVE_TOKENS, tokenCreateSchema, type MeDto, type TokenDto } from '@euta-cloud/shared';
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { DAY_MS } from '../clock.js';
import type { AppContext } from '../context.js';
import { apikeys } from '../db/schema.js';
import { AppError, notFound, parse } from '../http.js';
import { requirePrincipal, requireSession } from '../services/access.js';

const EXPIRING_SOON_MS = 7 * DAY_MS;

export async function meRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/me', async (req): Promise<MeDto> => {
    const p = requirePrincipal(req);
    return { ...p.user, auth: p.via, ...(p.tokenPermission ? { tokenPermission: p.tokenPermission } : {}) };
  });

  const activeWhere = (userId: string) =>
    and(eq(apikeys.referenceId, userId), or(eq(apikeys.enabled, true), isNull(apikeys.enabled)), or(isNull(apikeys.expiresAt), gt(apikeys.expiresAt, ctx.clock.now())));

  const toDto = (k: typeof apikeys.$inferSelect): TokenDto => {
    let permission: TokenDto['permission'] = 'read';
    try {
      permission = (JSON.parse(k.permissions ?? '{}') as { project?: string[] }).project?.includes('write') ? 'read_write' : 'read';
    } catch {
      /* default read */
    }
    return {
      id: k.id,
      name: k.name ?? '',
      permission,
      start: k.start,
      createdAt: k.createdAt.toISOString(),
      expiresAt: k.expiresAt?.toISOString() ?? null,
      lastUsedAt: k.lastRequest?.toISOString() ?? null,
      expiringSoon: !!k.expiresAt && k.expiresAt.getTime() - ctx.clock.now().getTime() < EXPIRING_SOON_MS,
    };
  };

  app.get('/api/me/tokens', async (req) => {
    const p = requireSession(req);
    const rows = await ctx.db.select().from(apikeys).where(activeWhere(p.user.id)).orderBy(desc(apikeys.createdAt));
    return { tokens: rows.map(toDto) };
  });

  app.post('/api/me/tokens', async (req, reply) => {
    const p = requireSession(req);
    const body = parse(tokenCreateSchema, req.body);
    const active = await ctx.db.$count(apikeys, activeWhere(p.user.id));
    if (active >= MAX_ACTIVE_TOKENS) {
      throw new AppError(409, 'TOKEN_LIMIT', `at most ${MAX_ACTIVE_TOKENS} active tokens per account — revoke one first`);
    }
    const created = await ctx.auth.api.createApiKey({
      body: {
        userId: p.user.id,
        name: body.name,
        expiresIn: body.expiresInDays * 24 * 60 * 60,
        permissions: { project: body.permission === 'read_write' ? ['read', 'write'] : ['read'] },
      },
    });
    const [row] = await ctx.db.select().from(apikeys).where(eq(apikeys.id, created.id));
    if (!row) throw new AppError(500, 'INTERNAL', 'token was not stored');
    reply.status(201);
    // The raw token is returned exactly once; the server keeps only its hash.
    return { token: created.key, ...toDto(row) };
  });

  app.delete<{ Params: { id: string } }>('/api/me/tokens/:id', async (req, reply) => {
    const p = requireSession(req);
    const res = await ctx.db.delete(apikeys).where(and(eq(apikeys.id, req.params.id), eq(apikeys.referenceId, p.user.id)));
    if (!res.rowCount) throw notFound('token');
    return reply.status(204).send();
  });
}
