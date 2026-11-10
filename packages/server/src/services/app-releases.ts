// App releases (SPEC_앱-배포-업데이트 "업데이트 배포", ADR-041): versions, file names, storage on the
// server volume, publish (one UPDATE switches every latest*.yml) and keep-3 retention per channel.
// Layout: `<UPDATES_DIR>/<channel>/<version>/<name>` for drafts and published releases alike.
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppArch, AppPlatform, AppReleaseFileKind } from '@euta-cloud/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import semver from 'semver';
import type { AppContext } from '../context.js';
import { appReleaseFiles, appReleases } from '../db/schema.js';
import { AppError, notFound } from '../http.js';

/** Published releases kept per channel; older ones lose their files and rows on publish. */
export const KEEP_PUBLISHED = 3;
/** Per-file upload cap (1 GiB). */
export const MAX_FILE_BYTES = 1024 ** 3;
export const DEFAULT_CHANNEL = 'alpha';

export interface FileClass {
  platform: AppPlatform;
  arch: AppArch | null;
  kind: AppReleaseFileKind;
}

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const CHANNEL = /^[a-z][a-z0-9]{0,19}$/;

/** A strict SemVer without build metadata (`0.1.0-alpha.3`), or null. */
export function parseVersion(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 64 || v.includes('+')) return null;
  if (semver.valid(v) !== v) return null;
  const pre = semver.prerelease(v);
  if (pre && !(typeof pre[0] === 'string' && CHANNEL.test(pre[0]))) return null;
  return v;
}

/** Channel = prerelease name (`0.1.0-alpha.3` → alpha), none → stable. Input must be a parsed version. */
export function channelOf(version: string): string {
  const pre = semver.prerelease(version);
  return pre ? String(pre[0]) : 'stable';
}

export const validChannel = (c: unknown): c is string => typeof c === 'string' && CHANNEL.test(c);

/** platform · arch · kind from an uploaded file name, or null when the type is not an app artifact. */
export function classifyFile(name: string): FileClass | null {
  if (!FILE_NAME.test(name)) return null;
  const arch: AppArch = /arm64|aarch64/i.test(name) ? 'arm64' : 'x64';
  if (name.endsWith('.yml')) return { platform: /-mac\.yml$/.test(name) ? 'mac' : /-linux(-[a-z0-9]+)?\.yml$/.test(name) ? 'linux' : 'win', arch: null, kind: 'meta' };
  const base = name.endsWith('.blockmap') ? name.slice(0, -'.blockmap'.length) : name;
  const blockmap = base !== name;
  const ext = base.slice(base.lastIndexOf('.') + 1);
  const platform: AppPlatform | null = ext === 'dmg' || ext === 'zip' ? 'mac' : ext === 'exe' ? 'win' : ext === 'AppImage' ? 'linux' : null;
  if (!platform || base.lastIndexOf('.') <= 0) return null;
  const kind: AppReleaseFileKind = blockmap || ext === 'zip' ? 'update' : 'installer';
  return { platform, arch, kind };
}

/** electron-updater meta files that make a release installable (`latest.yml` · `latest-mac.yml` · …). */
export const isUpdateMeta = (name: string) => /^latest(-[a-z0-9-]+)?\.yml$/.test(name);

export const releaseDir = (ctx: AppContext, channel: string, version: string) => join(ctx.config.updatesDir, channel, version);

export type ReleaseRow = typeof appReleases.$inferSelect;
export type ReleaseFileRow = typeof appReleaseFiles.$inferSelect;

export async function findRelease(ctx: AppContext, version: string): Promise<ReleaseRow> {
  const v = parseVersion(version);
  if (!v) throw notFound('release');
  const [row] = await ctx.db.select().from(appReleases).where(eq(appReleases.version, v));
  if (!row) throw notFound('release');
  return row;
}

const notDraft = (r: ReleaseRow) => new AppError(409, 'NOT_DRAFT', `release ${r.version} is already published`);

/** `userId` null → created by the server itself (GitHub mirror, ADR-048). */
export async function createRelease(ctx: AppContext, userId: string | null, version: string, notes: string): Promise<ReleaseRow> {
  const [existing] = await ctx.db.select({ id: appReleases.id }).from(appReleases).where(eq(appReleases.version, version));
  if (existing) throw new AppError(409, 'VERSION_EXISTS', `version ${version} already exists — bump the version`);
  try {
    const [row] = await ctx.db.insert(appReleases).values({ version, channel: channelOf(version), notes, createdBy: userId }).returning();
    return row!;
  } catch (e) {
    if ((e as { code?: string; cause?: { code?: string } }).code === '23505' || (e as { cause?: { code?: string } }).cause?.code === '23505') {
      throw new AppError(409, 'VERSION_EXISTS', `version ${version} already exists — bump the version`);
    }
    throw e;
  }
}

/**
 * Stream one file into a draft: temp file in the version folder → sha512 (base64, like electron-builder)
 * while writing → rename over the final name (a retry of the same name replaces it) → DB row.
 */
export async function saveReleaseFile(ctx: AppContext, release: ReleaseRow, name: string, body: Readable): Promise<{ name: string; size: number; sha512: string }> {
  const dir = releaseDir(ctx, release.channel, release.version);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.upload-${randomUUID()}`);
  const hash = createHash('sha512');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) return cb(new AppError(413, 'PAYLOAD_TOO_LARGE', `a release file may be at most ${MAX_FILE_BYTES} bytes`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(body, meter, createWriteStream(tmp, { flags: 'wx' }));
    const sha512 = hash.digest('base64');
    // Deleted or published while the bytes were arriving → drop the file.
    const [now] = await ctx.db.select({ status: appReleases.status }).from(appReleases).where(eq(appReleases.id, release.id));
    if (!now) throw notFound('release');
    if (now.status !== 'draft') throw notDraft(release);
    await rename(tmp, join(dir, name));
    const values = { releaseId: release.id, name, size, sha512, uploadedAt: ctx.clock.now() };
    await ctx.db.insert(appReleaseFiles).values(values).onConflictDoUpdate({ target: [appReleaseFiles.releaseId, appReleaseFiles.name], set: { size, sha512, uploadedAt: values.uploadedAt } });
    return { name, size, sha512 };
  } finally {
    await rm(tmp, { force: true });
  }
}

export async function filesOf(ctx: AppContext, releaseIds: string[]): Promise<Map<string, ReleaseFileRow[]>> {
  const out = new Map<string, ReleaseFileRow[]>();
  if (!releaseIds.length) return out;
  const rows = await ctx.db.select().from(appReleaseFiles).where(inArray(appReleaseFiles.releaseId, releaseIds)).orderBy(asc(appReleaseFiles.name));
  for (const r of rows) out.set(r.releaseId, [...(out.get(r.releaseId) ?? []), r]);
  return out;
}

/**
 * Publish a draft: needs at least one latest*.yml. One UPDATE flips it to published (from then on
 * `/updates/<channel>/<file>` resolves to it), then published releases beyond the newest 3 of the
 * channel are deleted — rows in the same transaction, folders after commit.
 */
export async function publishRelease(ctx: AppContext, release: ReleaseRow): Promise<{ version: string; publishedAt: string; removed: string[] }> {
  const publishedAt = ctx.clock.now();
  const removed = await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(appReleases).where(eq(appReleases.id, release.id)).for('update');
    if (!row) throw notFound('release');
    if (row.status !== 'draft') throw notDraft(row);
    const names = await tx.select({ name: appReleaseFiles.name }).from(appReleaseFiles).where(eq(appReleaseFiles.releaseId, row.id));
    if (!names.some((f) => isUpdateMeta(f.name))) throw new AppError(400, 'NO_UPDATE_META', 'upload latest*.yml (electron-builder update info) before publishing');
    await tx.update(appReleases).set({ status: 'published', publishedAt }).where(eq(appReleases.id, row.id));
    const old = await tx
      .select({ id: appReleases.id, version: appReleases.version })
      .from(appReleases)
      .where(and(eq(appReleases.channel, row.channel), eq(appReleases.status, 'published')))
      .orderBy(desc(appReleases.publishedAt), desc(appReleases.createdAt))
      .offset(KEEP_PUBLISHED);
    if (old.length) await tx.delete(appReleases).where(inArray(appReleases.id, old.map((o) => o.id)));
    return old.map((o) => o.version);
  });
  for (const v of removed) await rm(releaseDir(ctx, release.channel, v), { recursive: true, force: true });
  if (removed.length) ctx.log.info({ channel: release.channel, removed }, 'old app releases removed');
  return { version: release.version, publishedAt: publishedAt.toISOString(), removed };
}

export async function deleteDraft(ctx: AppContext, release: ReleaseRow): Promise<void> {
  const deleted = await ctx.db
    .delete(appReleases)
    .where(and(eq(appReleases.id, release.id), eq(appReleases.status, 'draft')))
    .returning({ id: appReleases.id });
  if (!deleted.length) throw notDraft(release);
  await rm(releaseDir(ctx, release.channel, release.version), { recursive: true, force: true });
}

/** Published releases of a channel, newest first (at most KEEP_PUBLISHED remain). */
export async function publishedReleases(ctx: AppContext, channel: string): Promise<ReleaseRow[]> {
  return ctx.db
    .select()
    .from(appReleases)
    .where(and(eq(appReleases.channel, channel), eq(appReleases.status, 'published')))
    .orderBy(desc(appReleases.publishedAt), desc(appReleases.createdAt))
    .limit(KEEP_PUBLISHED);
}

/** The newest published release of the channel that has a file of this name. */
export async function latestWithFile(ctx: AppContext, channel: string, name: string): Promise<ReleaseRow | null> {
  const [row] = await ctx.db
    .select({ release: appReleases })
    .from(appReleaseFiles)
    .innerJoin(appReleases, eq(appReleases.id, appReleaseFiles.releaseId))
    .where(and(eq(appReleases.channel, channel), eq(appReleases.status, 'published'), eq(appReleaseFiles.name, name)))
    .orderBy(desc(appReleases.publishedAt), desc(appReleases.createdAt))
    .limit(1);
  return row?.release ?? null;
}

export async function hasFile(ctx: AppContext, releaseId: string, name: string): Promise<boolean> {
  const [row] = await ctx.db
    .select({ name: appReleaseFiles.name })
    .from(appReleaseFiles)
    .where(and(eq(appReleaseFiles.releaseId, releaseId), eq(appReleaseFiles.name, name)));
  return !!row;
}

/** At least one published release in any channel — `GET /api/config` `appUpdates` (ADR-047). */
export async function hasPublishedRelease(ctx: AppContext): Promise<boolean> {
  const [row] = await ctx.db.select({ id: appReleases.id }).from(appReleases).where(eq(appReleases.status, 'published')).limit(1);
  return !!row;
}
