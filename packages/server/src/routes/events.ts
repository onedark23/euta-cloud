// GET /api/projects/:id/events — SSE change feed (ADR-022). `id:` = per-project seq.
// Resume: `Last-Event-ID` header (EventSource reconnect) or `?lastEventId=`. If the requested
// position is older than the retained feed, a `resync` event tells the client to reload everything.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { UserEventDto } from '@euta-cloud/shared';
import { projectAccess, projectAccessFor, requirePrincipal } from '../services/access.js';
import { userEventBounds, userEventsSince } from '../services/user-events.js';
import type { FeedRow } from '../services/feed.js';

export const HEARTBEAT_MS = 25_000;

/** Feed kinds after which the stream re-checks that the caller can still see the project (stage 15). */
const ACCESS_KINDS = new Set(['member.removed', 'member.left', 'member.role_changed', 'project.visibility_changed', 'project.transferred', 'project.deleted']);

export async function eventRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>('/api/projects/:id/events', async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const headerId = req.headers['last-event-id'];
    const rawLast = (Array.isArray(headerId) ? headerId[0] : headerId) ?? req.query.lastEventId;
    const requested = rawLast !== undefined && /^\d+$/.test(String(rawLast)) ? Number(rawLast) : null;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();

    let closed = false;
    let lastSent = 0;
    let pumping: Promise<void> = Promise.resolve();
    const write = (s: string) => {
      if (!closed) res.write(s);
    };
    const sendRow = (r: FeedRow) => {
      write(`id: ${r.seq}\nevent: change\ndata: ${JSON.stringify({ seq: r.seq, kind: r.kind, at: r.at.toISOString(), actorId: r.actorId, data: r.data })}\n\n`);
      lastSent = r.seq;
    };
    // Serialize fetches so events go out once and in order (NOTIFYs can arrive in bursts).
    const pump = () => {
      pumping = pumping.then(async () => {
        if (closed) return;
        for (;;) {
          const rows = await ctx.feed.since(project.id, lastSent);
          for (const r of rows) sendRow(r);
          if (rows.some((r) => ACCESS_KINDS.has(r.kind))) {
            // Removed, or the project became members-only / was deleted → tell the client and stop.
            const still = await projectAccessFor(ctx, principal, project.id, 'project.view').then(
              () => true,
              () => false,
            );
            if (!still) {
              write(`event: access_lost\ndata: ${JSON.stringify({ reason: 'not_visible' })}\n\n`);
              cleanup();
              res.end();
              return;
            }
          }
          if (rows.length < 500 || closed) break;
        }
      }).catch((err: Error) => req.log.warn({ err: { message: err.message } }, 'sse pump failed'));
    };

    // Subscribe before reading the backlog so nothing committed in between is missed.
    const unsubscribe = ctx.feed.subscribe(project.id, (seq) => {
      if (seq > lastSent) pump();
    });
    const heartbeat = setInterval(() => write(`: keep-alive\n\n`), HEARTBEAT_MS);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    res.on('close', cleanup);

    write(`retry: 3000\n\n`);
    const { minSeq, lastSeq } = await ctx.feed.bounds(project.id);
    if (requested === null) {
      // Fresh connection: start from now.
      lastSent = lastSeq;
      write(`id: ${lastSeq}\nevent: ready\ndata: ${JSON.stringify({ seq: lastSeq })}\n\n`);
    } else if (requested > lastSeq || (requested < lastSeq && (minSeq === null || minSeq > requested + 1))) {
      // Unknown future position, or events after `requested` were purged → full resync.
      lastSent = lastSeq;
      write(`id: ${lastSeq}\nevent: resync\ndata: ${JSON.stringify({ seq: lastSeq, reason: 'history no longer available' })}\n\n`);
    } else {
      lastSent = requested;
      write(`id: ${requested}\nevent: ready\ndata: ${JSON.stringify({ seq: requested })}\n\n`);
    }
    pump();
  });
}

/**
 * GET /api/me/events — app notifications (SPEC_클라우드-앱-연동 "앱 알림"): scheduled run outcomes in
 * projects I am a member of, and my own cloud runs ending. `id:` = global user-event id; resume
 * with `Last-Event-ID` / `?lastEventId=`, `resync` when that position was purged.
 */
export async function meEventRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Querystring: { lastEventId?: string } }>('/api/me/events', async (req, reply) => {
    const principal = requirePrincipal(req);
    const userId = principal.user.id;
    const headerId = req.headers['last-event-id'];
    const rawLast = (Array.isArray(headerId) ? headerId[0] : headerId) ?? req.query.lastEventId;
    const requested = rawLast !== undefined && /^\d+$/.test(String(rawLast)) ? Number(rawLast) : null;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders?.();

    let closed = false;
    let lastSent = 0;
    let pumping: Promise<void> = Promise.resolve();
    const write = (s: string) => {
      if (!closed) res.write(s);
    };
    const pump = () => {
      pumping = pumping
        .then(async () => {
          if (closed) return;
          for (;;) {
            const rows = await userEventsSince(ctx.db, userId, lastSent);
            for (const r of rows) {
              const dto: UserEventDto = { id: r.id, kind: r.kind as UserEventDto['kind'], at: r.at.toISOString(), projectId: r.projectId, runId: r.runId, data: r.data as UserEventDto['data'] };
              write(`id: ${r.id}\nevent: notification\ndata: ${JSON.stringify(dto)}\n\n`);
              lastSent = r.id;
            }
            if (rows.length < 500 || closed) break;
          }
        })
        .catch((err: Error) => req.log.warn({ err: { message: err.message } }, 'user sse pump failed'));
    };
    const unsubscribe = ctx.feed.onSignal('euta_user_events', pump);
    const heartbeat = setInterval(() => write(`: keep-alive\n\n`), HEARTBEAT_MS);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    res.on('close', cleanup);

    write(`retry: 3000\n\n`);
    const { minId, lastId } = await userEventBounds(ctx.db);
    if (requested === null) {
      lastSent = lastId;
      write(`id: ${lastId}\nevent: ready\ndata: ${JSON.stringify({ id: lastId })}\n\n`);
    } else if (requested > lastId || (requested < lastId && minId !== null && minId > requested + 1)) {
      lastSent = lastId;
      write(`id: ${lastId}\nevent: resync\ndata: ${JSON.stringify({ id: lastId, reason: 'history no longer available' })}\n\n`);
    } else {
      lastSent = requested;
      write(`id: ${requested}\nevent: ready\ndata: ${JSON.stringify({ id: requested })}\n\n`);
    }
    pump();
  });
}
