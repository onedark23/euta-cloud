// Internal runner API (SPEC 러너 프로토콜). Mounted on the separate internal listener
// (INTERNAL_PORT, cluster-only service — never behind the public ingress), and every request needs
// the shared runner token. Credential values pass through here exactly once per run and are never
// logged (Fastify logs no bodies).
import { timingSafeEqual } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { ClaimRequest, EventsRequest, FinishRequest } from '@euta-cloud/shared';
import type { FastifyInstance } from 'fastify';
import * as tar from 'tar-stream';
import type { AppContext } from '../context.js';
import { AppError, errorBody } from '../http.js';
import {
  applyEvents,
  claimRun,
  finishRun,
  issueCredentials,
  MAX_CLAIM_WAIT_MS,
  releaseRun,
  runForBaselines,
  storeResult,
  waitForQueueChange,
} from '../services/run-queue.js';
import { extractTar } from '../services/tar-upload.js';

type RunP = { Params: { id: string } };

const RUNNER_ID = /^[A-Za-z0-9._:-]{1,100}$/;

function runnerIdOf(v: unknown): string {
  if (typeof v !== 'string' || !RUNNER_ID.test(v)) throw new AppError(422, 'VALIDATION_FAILED', 'runnerId is required ([A-Za-z0-9._:-], ≤100)');
  return v;
}

function tokenOk(expected: string | null, header: string | undefined): boolean {
  if (!expected || !header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return false;
  const a = Buffer.from(m[1]!.trim());
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function internalRoutes(app: FastifyInstance, ctx: AppContext) {
  const waiters = new Set<AbortController>();
  app.addHook('preClose', async () => {
    for (const w of waiters) w.abort();
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!tokenOk(ctx.config.runnerToken, req.headers.authorization)) {
      return reply.status(401).send(errorBody('UNAUTHENTICATED', ctx.config.runnerToken ? 'runner token required' : 'internal API disabled (RUNNER_TOKEN not set)'));
    }
  });
  // Raw tar streams for result / baseline uploads (size is capped while extracting).
  app.addContentTypeParser(['application/x-tar', 'application/octet-stream'], (_req, payload, done) => done(null, payload));

  app.post('/internal/runner/claim', async (req, reply) => {
    const body = (req.body ?? {}) as Partial<ClaimRequest>;
    const runnerId = runnerIdOf(body.runnerId);
    const location = typeof body.location === 'string' && body.location.trim() ? body.location.trim().slice(0, 100) : 'default';
    if (!(Number(body.slots) > 0)) return reply.status(204).send();
    const wait = Math.min(Math.max(Number(body.waitMs) || 0, 0), MAX_CLAIM_WAIT_MS);
    let run = await claimRun(ctx, runnerId, location);
    if (!run && wait > 0) {
      // Long-poll: wake on NOTIFY euta_runs (new / unblocked run on any server instance).
      const ac = new AbortController();
      waiters.add(ac);
      // The response closes early when the runner gives up (stops) — then nothing may be leased to it.
      reply.raw.on('close', () => ac.abort());
      const deadline = Date.now() + wait;
      try {
        while (!run && !ac.signal.aborted && Date.now() < deadline) {
          await waitForQueueChange(ctx, deadline - Date.now(), ac.signal);
          if (!ac.signal.aborted) run = await claimRun(ctx, runnerId, location);
        }
      } finally {
        waiters.delete(ac);
      }
    }
    if (run && reply.raw.destroyed) {
      // The runner went away while we were claiming: hand the run back to the queue.
      await releaseRun(ctx, run.runId, runnerId);
      return reply;
    }
    if (!run) return reply.status(204).send();
    req.log.info({ runId: run.runId, runnerId }, 'run leased');
    return run;
  });

  app.post<RunP>('/internal/runs/:id/credentials', async (req) => {
    const runnerId = runnerIdOf((req.body as { runnerId?: unknown } | undefined)?.runnerId);
    return { secrets: await issueCredentials(ctx, req.params.id, runnerId) };
  });

  app.post<RunP>('/internal/runs/:id/events', async (req) => {
    const body = (req.body ?? {}) as Partial<EventsRequest>;
    const runnerId = runnerIdOf(body.runnerId);
    return applyEvents(ctx, req.params.id, { runnerId, events: Array.isArray(body.events) ? body.events : [], ...(body.engineRunId ? { engineRunId: body.engineRunId } : {}) });
  });

  app.put<RunP>('/internal/runs/:id/result', async (req) => {
    const runnerId = runnerIdOf(req.headers['x-euta-runner-id']);
    if (!req.body || typeof (req.body as Readable).pipe !== 'function') throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'send the result folder as application/x-tar');
    const res = await storeResult(ctx, req.params.id, runnerId, req.body as Readable);
    req.log.info({ runId: req.params.id, files: res.files, bytes: res.bytes }, 'run result stored');
    return res;
  });

  app.post<RunP>('/internal/runs/:id/finish', async (req) => {
    const body = (req.body ?? {}) as Partial<FinishRequest>;
    const runnerId = runnerIdOf(body.runnerId);
    const run = await finishRun(ctx, req.params.id, { ...(body as FinishRequest), runnerId });
    req.log.info({ runId: run.id, status: run.status }, 'run finished');
    return { status: run.status };
  });

  // Visual baselines for (environment, runner location) — ADR-021 §2. The runner downloads them
  // before the engine starts and uploads baselines the engine created (existing ones are kept).
  app.get<RunP>('/internal/runs/:id/baselines', async (req, reply) => {
    const runnerId = runnerIdOf(req.headers['x-euta-runner-id']);
    const run = await runForBaselines(ctx, req.params.id, runnerId);
    const location = run.runnerLocation ?? 'default';
    const files = await ctx.results.listBaselines(run.projectId, run.environmentId!, location);
    const pack = tar.pack();
    (async () => {
      for (const f of files) {
        const file = await ctx.results.getBaseline(run.projectId, run.environmentId!, location, f.path);
        if (!file) continue;
        await new Promise<void>((resolve, reject) => {
          const entry = pack.entry({ name: f.path, size: file.size }, (err) => (err ? reject(err) : resolve()));
          file.stream.pipe(entry);
        });
      }
      pack.finalize();
    })().catch((err: Error) => pack.destroy(err));
    reply.type('application/x-tar');
    return reply.send(pack);
  });

  app.put<RunP>('/internal/runs/:id/baselines', async (req) => {
    const runnerId = runnerIdOf(req.headers['x-euta-runner-id']);
    const run = await runForBaselines(ctx, req.params.id, runnerId);
    let added = 0;
    await extractTar(req.body as Readable, ctx.config.resultMaxRunBytes, async (rel, data) => {
      if (await ctx.results.putBaseline(run.projectId, run.environmentId!, run.runnerLocation ?? 'default', rel, data)) added++;
    });
    return { added };
  });

  app.setNotFoundHandler(async (_req, reply) => reply.status(404).send(errorBody('NOT_FOUND', 'route not found')));
}

