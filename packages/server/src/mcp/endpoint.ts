// Remote MCP endpoint (SPEC_클라우드-MCP "연결"): Streamable HTTP at /mcp, no SSE transport.
// Personal tokens only (`Authorization: Bearer euta_…`) — no cookie or device sessions. Stateless:
// every HTTP request gets a fresh McpServer bound to the authenticated principal, so permission
// changes, revocation and deactivation apply to the very next call. The token rate limit
// (120/min, Better Auth api-key plugin) counts every HTTP request and answers 429.
import { Readable } from 'node:stream';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError, errorBody } from '../http.js';
import { authenticate, type Principal } from '../services/access.js';
import { buildMcpServer } from './tools.js';

const MCP_BODY_LIMIT = 1024 * 1024;

function unauthorized(reply: FastifyReply, message: string) {
  // RFC 6750: a bearer-protected resource names its scheme on 401.
  reply.header('www-authenticate', 'Bearer realm="euta-cloud"');
  return reply.status(401).send(errorBody('UNAUTHENTICATED', message));
}

export async function mcpRoutes(app: FastifyInstance, ctx: AppContext) {
  // authInfo is passed through to the factory as-is (same object), so it keys the principal.
  const principals = new WeakMap<AuthInfo, Principal>();
  const handler = createMcpHandler(
    ({ authInfo }) => {
      const principal = authInfo ? principals.get(authInfo) : undefined;
      // The route below always authenticates first; reaching here without a principal is a bug.
      if (!principal) throw new Error('mcp request without principal');
      return buildMcpServer(ctx, principal);
    },
    {
      // Default response shaping ('auto'): JSON unless a tool emits a message before its result (none do).
      onerror: (err) => ctx.log.warn({ component: 'mcp', err: { message: err.message } }, 'mcp request rejected'),
    },
  );
  app.addHook('onClose', async () => handler.close());

  await app.register(async (scope) => {
    // Raw body: the MCP handler parses JSON-RPC itself.
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MCP_BODY_LIMIT }, (_req, body, done) => done(null, body));
    scope.route({
      method: ['GET', 'POST', 'DELETE'],
      url: '/mcp',
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const authz = req.headers.authorization;
        if (typeof authz !== 'string' || !/^Bearer\s+euta_\S+$/i.test(authz.trim())) {
          return unauthorized(reply, 'a personal token is required: Authorization: Bearer euta_…');
        }
        let principal: Principal | null;
        try {
          principal = await authenticate(ctx, req);
        } catch (e) {
          if (e instanceof AppError && e.status === 401) return unauthorized(reply, e.message);
          if (e instanceof AppError && e.status === 429) reply.header('retry-after', '60');
          throw e;
        }
        if (!principal || principal.via !== 'token') return unauthorized(reply, 'a personal token is required');

        const url = new URL(req.url, ctx.config.baseUrl);
        const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
        const request = new Request(url, { method: req.method, headers: fromNodeHeaders(req.headers), ...(body ? { body } : {}) });
        // The raw token never leaves the auth check.
        const authInfo: AuthInfo = { token: '[redacted]', clientId: principal.tokenId ?? 'token', scopes: [principal.tokenPermission ?? 'read'] };
        principals.set(authInfo, principal);
        const res = await handler.fetch(request, { authInfo });
        reply.status(res.status);
        res.headers.forEach((v, k) => {
          if (k !== 'content-length') reply.header(k, v);
        });
        return reply.send(res.body ? Readable.fromWeb(res.body as import('node:stream/web').ReadableStream) : null);
      },
    });
  });
}
