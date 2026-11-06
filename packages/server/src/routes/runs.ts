// Runs API (SPEC_클라우드-실행-예약 "API 개요"): request (with precheck), precheck only, list, get,
// cancel, result files and report. Run/cancel = editor+ (`run.execute`); reading = everyone.
import type { Readable } from 'node:stream';
import { runCreateSchema, runListQuerySchema, runUploadQuerySchema, type RunFileDto } from '@euta-cloud/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import { runs } from '../db/schema.js';
import { AppError, notFound, parse } from '../http.js';
import { uploadLocalRun } from '../services/local-upload.js';
import { projectAccess } from '../services/access.js';
import { safeRelPath } from '../services/result-store.js';
import { suiteReport } from '../services/suite-report.js';
import { cancelRun, childrenOf, createRun, listRunRows, loadRun, planRun, precheckDto, precheckError, runDetailDto, runDto } from '../services/runs.js';

type P = { Params: { id: string } };
type RunP = { Params: { id: string; runId: string } };
type FileP = { Params: { id: string; runId: string; '*': string } };

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  webm: 'video/webm',
  mp4: 'video/mp4',
  json: 'application/json; charset=utf-8',
  har: 'application/json; charset=utf-8',
  jsonl: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  zip: 'application/zip',
  pdf: 'application/pdf',
};
const INLINE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'webm', 'mp4', 'json', 'har', 'jsonl', 'log', 'txt', 'csv']);

/**
 * The report is engine-generated static HTML (no scripts). Served inline only as `report.html` at
 * the run root, with a CSP that forbids scripts, plugins, forms and framing by other origins; images
 * and video load from the same run folder through relative links.
 */
const REPORT_CSP = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

function sendFile(reply: FastifyReply, rel: string, file: { stream: NodeJS.ReadableStream; size: number }) {
  const name = rel.split('/').pop()!;
  const ext = (name.includes('.') ? name.split('.').pop()! : '').toLowerCase();
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', 'private, max-age=300');
  reply.header('content-length', String(file.size));
  if (rel === 'report.html') {
    reply.header('content-security-policy', REPORT_CSP);
    reply.type('text/html; charset=utf-8');
  } else {
    reply.header('content-security-policy', "default-src 'none'; sandbox");
    reply.type(TYPES[ext] ?? 'application/octet-stream');
    if (!INLINE.has(ext)) reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  }
  return reply.send(file.stream);
}

export async function runRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const base = '/api/projects/:id/runs';

  app.post<P>(`${base}/precheck`, async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'run.execute');
    const body = parse(runCreateSchema, req.body);
    return precheckDto(await planRun(ctx, project, body));
  });

  app.post<P>(base, async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'run.execute');
    const body = parse(runCreateSchema, req.body);
    const plan = await planRun(ctx, project, body);
    if (plan.problems.length) throw precheckError(plan);
    const id = await createRun(ctx, principal, project, body, plan);
    const run = await loadRun(db, project.id, id);
    reply.status(201);
    return runDetailDto(run, run.kind === 'suite' ? await childrenOf(db, id) : undefined);
  });

  // Local run upload (source local_upload): tar body streamed through the result store checks.
  await app.register(async (scope) => {
    scope.addContentTypeParser(['application/x-tar', 'application/octet-stream'], (_req, payload, done) => done(null, payload));
    scope.post<P & { Querystring: Record<string, string> }>(`${base}/upload`, async (req, reply) => {
      const { project, principal } = await projectAccess(ctx, req, req.params.id, 'run.upload');
      const q = parse(runUploadQuerySchema, req.query);
      if (!req.body || typeof (req.body as Readable).pipe !== 'function') throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'send the engine run folder as application/x-tar');
      const id = await uploadLocalRun(ctx, principal, project, q, req.body as Readable);
      reply.status(201);
      return runDetailDto(await loadRun(db, project.id, id));
    });
  });

  app.get<P & { Querystring: Record<string, string> }>(base, async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const q = parse(runListQuerySchema, req.query);
    const rows = await listRunRows(ctx, project.id, q);
    return { runs: rows.map(runDto) };
  });

  app.get<RunP>(`${base}/:runId`, async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const run = await loadRun(db, project.id, req.params.runId);
    const [retry] = await db.select({ id: runs.id }).from(runs).where(eq(runs.retryOfRunId, run.id));
    return { ...runDetailDto(run, run.kind === 'suite' ? await childrenOf(db, run.id) : undefined), retryRunId: retry?.id ?? null };
  });

  // Test set report data of a set (parent) run (ADR-032): previous run comparison + failure details.
  app.get<RunP>(`${base}/:runId/suite-report`, async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    return suiteReport(ctx, await loadRun(db, project.id, req.params.runId));
  });

  app.post<RunP>(`${base}/:runId/cancel`, async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'run.execute');
    const run = await cancelRun(ctx, principal, project.id, req.params.runId);
    // 202 while the runner still has to stop the engine.
    reply.status(run.status === 'cancelled' ? 200 : 202);
    return runDto(run);
  });

  app.get<RunP>(`${base}/:runId/files`, async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const run = await loadRun(db, project.id, req.params.runId);
    const files: RunFileDto[] = run.resultFiles === 'present' ? await ctx.results.list(project.id, run.id) : [];
    return { resultFiles: run.resultFiles, files };
  });

  app.get<FileP>(`${base}/:runId/files/*`, async (req, reply) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const run = await loadRun(db, project.id, req.params.runId);
    const rel = safeRelPath(req.params['*']);
    if (!rel || run.resultFiles !== 'present') throw notFound('file');
    const file = await ctx.results.get(project.id, run.id, rel);
    if (!file) throw notFound('file');
    return sendFile(reply, rel, file);
  });

  // report.html links its screenshots relatively, so it is served from the files path.
  app.get<RunP>(`${base}/:runId/report`, async (req, reply) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const run = await loadRun(db, project.id, req.params.runId);
    const report = run.resultFiles === 'present' ? await ctx.results.get(project.id, run.id, 'report.html') : null;
    if (!report) throw notFound('report');
    report.stream.destroy();
    return reply.redirect(`/api/projects/${project.id}/runs/${run.id}/files/report.html`, 302);
  });
}
