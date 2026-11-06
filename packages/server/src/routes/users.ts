// Org user search for invites (SPEC API "사용자 검색"): GET /api/users?q= — any active member
// (session or token; read is enough). Active users only, name/email prefix, at most 20, id/name/email.
import { USER_SEARCH_LIMIT, userSearchQuerySchema, type UserSummaryDto } from '@euta-cloud/shared';
import { and, asc, eq, ilike, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { users } from '../db/schema.js';
import { parse } from '../http.js';
import { requirePrincipal } from '../services/access.js';

/** LIKE pattern for "starts with q" (wildcards in q are literal). */
const prefixPattern = (q: string) => `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function userRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/users', async (req): Promise<{ users: UserSummaryDto[] }> => {
    requirePrincipal(req);
    const { q } = parse(userSearchQuerySchema, req.query);
    const pattern = q ? prefixPattern(q) : null;
    const rows = await ctx.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.status, 'active'), pattern ? or(ilike(users.name, pattern), ilike(users.email, pattern)) : undefined))
      .orderBy(asc(users.name), asc(users.email))
      .limit(USER_SEARCH_LIMIT);
    return { users: rows };
  });
}
