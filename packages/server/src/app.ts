// Fastify app factory. Everything injectable for tests: clock, DNS resolver, mailer, log stream.
import { existsSync } from 'node:fs';
import type { ServerConfigDto } from '@euta-cloud/shared';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import fastifyStatic from '@fastify/static';
import { fromNodeHeaders } from 'better-auth/node';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { createAuth } from './auth.js';
import { systemClock, type Clock } from './clock.js';
import type { Config } from './config.js';
import type { AppContext } from './context.js';
import { createDb } from './db/index.js';
import { orgSettings, users } from './db/schema.js';
import { errorBody, errorHandler } from './http.js';
import { smtpMailer, type Mailer } from './mail.js';
import { accessRoutes } from './routes/access.js';
import { activityRoutes } from './routes/activity.js';
import { adminRoutes } from './routes/admin.js';
import { environmentRoutes } from './routes/environments.js';
import { eventRoutes, meEventRoutes } from './routes/events.js';
import { meRoutes } from './routes/me.js';
import { projectRoutes } from './routes/projects.js';
import { scriptRoutes } from './routes/scripts.js';
import { suiteRoutes } from './routes/suites.js';
import { userRoutes } from './routes/users.js';
import { authenticate, type Principal } from './services/access.js';
import { dnsResolver, type HostResolver } from './services/address-check.js';
import { ChangeFeed } from './services/feed.js';
import { FsResultStore, type ResultStore } from './services/result-store.js';
import { internalRoutes } from './routes/internal.js';
import { mcpRoutes } from './mcp/endpoint.js';
import { runRoutes } from './routes/runs.js';
import { scheduleRoutes } from './routes/schedules.js';
import type { FetchLike } from './services/notify.js';
import { inArray } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export interface AppDeps {
  clock?: Clock;
  resolveHost?: HostResolver;
  /** Overrides SMTP_URL; pass null to force admin-approval mode. */
  mailer?: Mailer | null;
  /** Log destination (tests capture logs to scan for secrets). */
  logStream?: Writable;
  results?: ResultStore;
  /** Outbound HTTP for Teams webhooks (default: global fetch). */
  fetch?: FetchLike;
}

const PLACEHOLDER_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>euta cloud</title></head>
<body><h1>euta cloud</h1><p>웹 화면은 준비 중입니다 (C4).</p></body></html>`;

export async function buildApp(
  config: Config,
  deps: AppDeps = {},
): Promise<{ app: FastifyInstance; internal: FastifyInstance; ctx: AppContext }> {
  const logger = {
    level: config.logLevel,
    ...(deps.logStream ? { stream: deps.logStream } : {}),
    // Never log auth material.
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  };
  const app = Fastify({ logger, bodyLimit: 1024 * 1024, trustProxy: true });
  // Internal runner API: its own listener (INTERNAL_PORT), so the public ingress never routes to it.
  // forceCloseConnections: runner keep-alive / long-poll sockets must not hold shutdown (runners retry).
  const internal = Fastify({ logger, bodyLimit: 16 * 1024 * 1024, forceCloseConnections: true });
  const { pool, db } = createDb(config.databaseUrl);
  const clock = deps.clock ?? systemClock;
  const mailer = deps.mailer !== undefined ? deps.mailer : config.smtpUrl ? smtpMailer(config.smtpUrl, config.mailFrom) : null;
  const auth = createAuth({ config, db, clock, mailer, log: app.log });
  const feed = new ChangeFeed(config.databaseUrl, db, app.log);
  const ctx: AppContext = {
    config,
    db,
    pool,
    auth,
    feed,
    results: deps.results ?? new FsResultStore(config.resultsDir),
    clock,
    resolveHost: deps.resolveHost ?? dnsResolver,
    mailer,
    approvalMode: mailer === null,
    log: app.log,
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
  };

  await feed.start();
  app.addHook('onClose', async () => {
    await feed.stop();
    await pool.end();
  });

  // Mirror org settings / admin list from config (single organization).
  await db
    .insert(orgSettings)
    .values({ id: 1, allowedDomains: config.allowedEmailDomains, approvalMode: ctx.approvalMode })
    .onConflictDoUpdate({ target: orgSettings.id, set: { allowedDomains: config.allowedEmailDomains, approvalMode: ctx.approvalMode, updatedAt: sql`now()` } });
  if (config.adminEmails.length) {
    await db.update(users).set({ isAdmin: true }).where(inArray(users.email, config.adminEmails));
  }

  app.setErrorHandler(errorHandler);
  app.decorateRequest('principal', null);

  // ── Better Auth (/api/auth/*) — raw body pass-through so JSON and form posts both work.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      handler: async (req, reply) => {
        const url = new URL(req.url, config.baseUrl);
        // Personal tokens are managed only through /api/me/tokens (count limit, expiry choices).
        if (/^\/api\/auth\/api-key(\/|$)/.test(url.pathname)) return reply.status(404).send(errorBody('NOT_FOUND', 'not found'));
        const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
        const res = await auth.handler(new Request(url, { method: req.method, headers: fromNodeHeaders(req.headers), body }));
        reply.status(res.status);
        res.headers.forEach((v, k) => {
          if (k !== 'set-cookie' && k !== 'content-length') reply.header(k, v);
        });
        const cookies = res.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        const text = res.body ? await res.text() : '';
        // Add the euta error envelope to Better Auth errors ({code,message}) while keeping the
        // original fields for the Better Auth client. RFC 8628 errors ({error: string}) stay as-is.
        if (res.status >= 400 && text && (res.headers.get('content-type') ?? '').includes('json')) {
          try {
            const j = JSON.parse(text) as Record<string, unknown>;
            if (j && typeof j === 'object' && !('error' in j)) {
              const code = typeof j.code === 'string' ? j.code : `HTTP_${res.status}`;
              return reply.send({ ...j, error: { code, message: typeof j.message === 'string' ? j.message : res.statusText } });
            }
          } catch {
            /* not JSON */
          }
        }
        return reply.send(text || null);
      },
    });
  });

  // ── euta API
  await app.register(async (api) => {
    api.addHook('onRequest', async (req) => {
      req.principal = await authenticate(ctx, req);
    });
    // Public: what the sign-up / login pages need to know (no auth).
    api.get('/api/config', async (): Promise<ServerConfigDto> => ({
      signUpMode: ctx.approvalMode ? 'approval' : 'email',
      allowedEmailDomains: config.allowedEmailDomains,
      microsoftLogin: config.microsoft !== null,
    }));
    await meRoutes(api, ctx);
    await userRoutes(api, ctx);
    await adminRoutes(api, ctx);
    await projectRoutes(api, ctx);
    await accessRoutes(api, ctx);
    await environmentRoutes(api, ctx);
    await scriptRoutes(api, ctx);
    await suiteRoutes(api, ctx);
    await activityRoutes(api, ctx);
    await eventRoutes(api, ctx);
    await meEventRoutes(api, ctx);
    await runRoutes(api, ctx);
    await scheduleRoutes(api, ctx);
  });

  // ── Remote MCP (/mcp, personal tokens only)
  await mcpRoutes(app, ctx);

  internal.setErrorHandler(errorHandler);
  await internal.register(async (scope) => internalRoutes(scope, ctx));
  internal.get('/healthz', async () => ({ ok: true }));
  // Close order: `internal` first, then `app` (whose onClose ends the DB pool) — see main.ts.

  app.get('/healthz', async () => ({ ok: true }));
  // Readiness (k8s readinessProbe): the database answers. Liveness stays on /healthz (process only).
  app.get('/readyz', async (_req, reply) => {
    try {
      await pool.query('select 1');
      return { ok: true };
    } catch {
      return reply.status(503).send(errorBody('NOT_READY', 'database unavailable'));
    }
  });

  // ── Web UI (built by packages/web) — static files + SPA fallback; placeholder until C4.
  const webDist = config.webDist;
  const hasIndex = webDist !== null && existsSync(join(webDist, 'index.html'));
  if (webDist) await app.register(fastifyStatic, { root: webDist, wildcard: false, index: ['index.html'] });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/') || req.url === '/api' || req.method !== 'GET') {
      return reply.status(404).send(errorBody('NOT_FOUND', 'route not found'));
    }
    if (hasIndex) return reply.type('text/html').sendFile('index.html');
    return reply.type('text/html').send(PLACEHOLDER_HTML);
  });

  return { app, internal, ctx };
}
