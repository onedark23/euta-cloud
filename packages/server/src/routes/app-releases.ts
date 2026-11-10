// App release routes (SPEC_앱-배포-업데이트, API contract stage 17).
// Public (no auth — the app checks before sign-in; the ingress allows office IPs only):
//   GET /updates/:channel/:file · GET /updates/:channel/:version/:file · GET /api/app/releases · GET /api/app/compat
// Admin (admin session or admin read_write personal token):
//   GET/POST /api/admin/app-releases · PUT …/:version/files/:name · POST …/:version/publish · DELETE …/:version
//   POST /api/admin/app-releases/mirror (GitHub release mirror sync now, ADR-048)
import type { Readable } from 'node:stream';
import send from '@fastify/send';
import type { AdminAppReleaseDto, AdminAppReleasesDto, AppCompatDto, AppMirrorStatusDto, AppReleasesDto } from '@euta-cloud/shared';
import { desc } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { appReleases } from '../db/schema.js';
import { AppError, errorBody, forbidden } from '../http.js';
import { requirePrincipal, type Principal } from '../services/access.js';
import {
  classifyFile,
  createRelease,
  DEFAULT_CHANNEL,
  deleteDraft,
  filesOf,
  findRelease,
  hasFile,
  latestWithFile,
  MAX_FILE_BYTES,
  parseVersion,
  publishedReleases,
  publishRelease,
  releaseDir,
  saveReleaseFile,
  validChannel,
  type ReleaseRow,
} from '../services/app-releases.js';

const TYPES: Record<string, string> = {
  yml: 'text/yaml; charset=utf-8',
  zip: 'application/zip',
  dmg: 'application/x-apple-diskimage',
  exe: 'application/vnd.microsoft.portable-executable',
  AppImage: 'application/octet-stream',
  blockmap: 'application/octet-stream',
};

const notFoundReply = (reply: FastifyReply) => reply.status(404).send(errorBody('NOT_FOUND', 'file not found'));

/** Stream a release file with Range / ETag / Last-Modified (@fastify/send). latest*.yml is never cached. */
async function serveFile(req: FastifyRequest, reply: FastifyReply, ctx: AppContext, release: ReleaseRow, name: string, cache: string) {
  const r = await send(req.raw, `/${name}`, {
    root: releaseDir(ctx, release.channel, release.version),
    index: false,
    dotfiles: 'deny',
    cacheControl: false,
    contentType: false,
  });
  if (r.type !== 'file') {
    const code = r.type === 'error' ? (r.metadata.error as NodeJS.ErrnoException).code : undefined;
    if (r.type === 'directory' || code === 'ENOENT' || r.statusCode === 404) return notFoundReply(reply);
    reply.status(r.statusCode).headers(r.headers);
    return reply.send(errorBody(r.statusCode === 416 ? 'RANGE_NOT_SATISFIABLE' : 'BAD_REQUEST', 'cannot serve this range'));
  }
  const ext = name.slice(name.lastIndexOf('.') + 1);
  reply.status(r.statusCode).headers(r.headers);
  reply.header('content-type', TYPES[ext] ?? 'application/octet-stream');
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', ext === 'yml' ? 'no-store' : cache);
  if (ext !== 'yml') reply.header('content-disposition', `attachment; filename="${name}"`);
  return reply.send(r.stream);
}

export async function appReleasePublicRoutes(app: FastifyInstance, ctx: AppContext) {
  const urlOf = (channel: string, version: string, name: string) => `${ctx.config.baseUrl}/updates/${channel}/${version}/${name}`;

  app.get<{ Params: { channel: string; file: string } }>('/updates/:channel/:file', async (req, reply) => {
    const { channel, file } = req.params;
    if (!validChannel(channel) || !classifyFile(file)) return notFoundReply(reply);
    const release = await latestWithFile(ctx, channel, file);
    if (!release) return notFoundReply(reply);
    // The file under this path can change on the next publish → short cache only.
    return serveFile(req, reply, ctx, release, file, 'public, max-age=60');
  });

  app.get<{ Params: { channel: string; version: string; file: string } }>('/updates/:channel/:version/:file', async (req, reply) => {
    const { channel, version, file } = req.params;
    const v = parseVersion(version);
    if (!validChannel(channel) || !v || !classifyFile(file)) return notFoundReply(reply);
    const [release] = (await publishedReleases(ctx, channel)).filter((r) => r.version === v);
    if (!release || !(await hasFile(ctx, release.id, file))) return notFoundReply(reply);
    // A version path never changes content.
    return serveFile(req, reply, ctx, release, file, 'public, max-age=86400, immutable');
  });

  app.get<{ Querystring: { channel?: string } }>('/api/app/releases', async (req): Promise<AppReleasesDto> => {
    const channel = req.query.channel ?? DEFAULT_CHANNEL;
    if (!validChannel(channel)) throw new AppError(400, 'INVALID_CHANNEL', 'channel must be a lowercase name such as alpha');
    const rows = await publishedReleases(ctx, channel);
    const files = await filesOf(ctx, rows.map((r) => r.id));
    return {
      channel,
      releases: rows.map((r) => ({
        version: r.version,
        publishedAt: r.publishedAt!.toISOString(),
        notes: r.notes,
        files: (files.get(r.id) ?? []).flatMap((f) => {
          const c = classifyFile(f.name);
          return c ? [{ ...c, name: f.name, size: f.size, url: urlOf(channel, r.version, f.name) }] : [];
        }),
      })),
    };
  });

  app.get('/api/app/compat', async (): Promise<AppCompatDto> => ({ minVersion: ctx.config.minAppVersion }));
}

/** Release admin: an administrator signed in on the web, or an administrator's read_write personal token. */
function requireReleaseAdmin(req: FastifyRequest): Principal {
  const p = requirePrincipal(req);
  if (!p.user.isAdmin) throw forbidden('administrator only');
  if (p.via === 'token' && p.tokenPermission !== 'read_write') throw forbidden('uploading app releases needs a read_write personal token');
  return p;
}

const badVersion = () => new AppError(400, 'INVALID_VERSION', 'version must be SemVer such as 0.1.0-alpha.1 (no build metadata)');

export async function appReleaseAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const base = '/api/admin/app-releases';
  type VP = { Params: { version: string } };

  app.get(base, async (req): Promise<AdminAppReleasesDto> => {
    requireReleaseAdmin(req);
    const rows = await ctx.db.select().from(appReleases).orderBy(desc(appReleases.createdAt));
    const files = await filesOf(ctx, rows.map((r) => r.id));
    return {
      releases: rows.map((r) => ({
        version: r.version,
        channel: r.channel,
        status: r.status as AdminAppReleaseDto['status'],
        notes: r.notes,
        createdAt: r.createdAt.toISOString(),
        publishedAt: r.publishedAt?.toISOString() ?? null,
        files: (files.get(r.id) ?? []).flatMap((f) => {
          const c = classifyFile(f.name);
          return c ? [{ name: f.name, size: f.size, sha512: f.sha512, ...c }] : [];
        }),
      })),
      mirror: ctx.mirror?.status() ?? null,
    };
  });

  // GitHub release mirror: sync now (waits for a run already in progress) and return the status.
  app.post(`${base}/mirror`, async (req): Promise<AppMirrorStatusDto> => {
    requireReleaseAdmin(req);
    if (!ctx.mirror) throw new AppError(409, 'MIRROR_OFF', 'the GitHub release mirror is off (APP_MIRROR_GITHUB is not set)');
    return ctx.mirror.run();
  });

  app.post(base, async (req, reply) => {
    const p = requireReleaseAdmin(req);
    const body = (req.body ?? {}) as { version?: unknown; notes?: unknown };
    const version = parseVersion(body.version);
    if (!version) throw badVersion();
    if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 20_000)) {
      throw new AppError(400, 'INVALID_NOTES', 'notes must be text up to 20000 characters');
    }
    const row = await createRelease(ctx, p.user.id, version, (body.notes as string | undefined) ?? '');
    reply.status(201);
    return { version: row.version, channel: row.channel, status: 'draft' };
  });

  // File upload: raw body streamed to disk (Fastify's bodyLimit does not apply to a pass-through parser,
  // so the 1 GiB cap is enforced here — Content-Length up front, byte count while streaming).
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
    scope.put<{ Params: { version: string; name: string } }>(`${base}/:version/files/:name`, async (req, reply) => {
      requireReleaseAdmin(req);
      const { name } = req.params;
      if (!classifyFile(name)) {
        throw new AppError(400, 'UNSUPPORTED_FILE', 'file name must match [A-Za-z0-9._-]+ and be .dmg · .zip · .exe · .AppImage · .blockmap · .yml');
      }
      const release = await findRelease(ctx, req.params.version);
      if (release.status !== 'draft') throw new AppError(409, 'NOT_DRAFT', `release ${release.version} is already published`);
      if (Number(req.headers['content-length'] ?? 0) > MAX_FILE_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE', `a release file may be at most ${MAX_FILE_BYTES} bytes`);
      if (!req.body || typeof (req.body as Readable).pipe !== 'function') throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'send the file as application/octet-stream');
      const saved = await saveReleaseFile(ctx, release, name, req.body as Readable);
      reply.status(201);
      return saved;
    });
  });

  app.post<VP>(`${base}/:version/publish`, async (req) => {
    requireReleaseAdmin(req);
    const { version, publishedAt } = await publishRelease(ctx, await findRelease(ctx, req.params.version));
    return { version, publishedAt };
  });

  app.delete<VP>(`${base}/:version`, async (req) => {
    requireReleaseAdmin(req);
    const release = await findRelease(ctx, req.params.version);
    await deleteDraft(ctx, release);
    return { version: release.version, deleted: true };
  });
}
