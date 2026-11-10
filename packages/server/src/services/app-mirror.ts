// GitHub release mirror (ADR-048 decision 2, SPEC_앱-배포-업데이트 "GitHub 에서 자동으로 가져오기"): with
// APP_MIRROR_GITHUB=<owner/repo> the server imports the repo's latest GitHub release into its own update
// feed — 1 minute after start, then every APP_MIRROR_INTERVAL, or now from the admin web.
// One run: latest tag from the `releases/latest` redirect (no GitHub API — 60 anonymous calls/hour per
// IP) → latest-mac.yml · latest.yml · latest-linux.yml of that tag (404 = platform absent) → a version
// the server does not have yet → draft → every yml file (sha512 checked against the yml) + its
// .blockmap (if any) + the yml itself through saveReleaseFile → publish. Any failure deletes the draft.
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { AppMirrorResult, AppMirrorStatusDto } from '@euta-cloud/shared';
import { and, eq } from 'drizzle-orm';
import semver from 'semver';
import { parse as parseYaml } from 'yaml';
import type { AppMirrorConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { appReleases } from '../db/schema.js';
import { AppError } from '../http.js';
import { channelOf, classifyFile, createRelease, deleteDraft, MAX_FILE_BYTES, parseVersion, publishRelease, saveReleaseFile, type ReleaseRow } from './app-releases.js';

/** electron-builder update info files, one per platform. */
export const MIRROR_YMLS = ['latest-mac.yml', 'latest.yml', 'latest-linux.yml'] as const;
/** First run after server start. */
export const MIRROR_START_DELAY_MS = 60_000;
/** Redirect lookup and yml / blockmap downloads. */
const SMALL_TIMEOUT_MS = 30_000;
/** One installer / update file (≤ 1 GiB). */
const FILE_TIMEOUT_MS = 30 * 60_000;
/** Same cap as the admin create route. */
const MAX_NOTES = 20_000;
const TAG = /^[A-Za-z0-9._-]{1,128}$/;

export interface MirrorRun {
  at: string;
  result: AppMirrorResult;
  version?: string;
  message?: string;
}

class MirrorError extends Error {}

interface UpdateInfo {
  name: string;
  bytes: Buffer;
  version: string;
  files: { name: string; sha512: string }[];
  notes: string | undefined;
}

/** electron-updater release notes (string, or per-version list) → text (same rule as the app's notesText). */
export function notesText(n: unknown): string | undefined {
  if (typeof n === 'string') return n.trim() || undefined;
  if (Array.isArray(n)) {
    const s = n
      .map((x) => (x && typeof x === 'object' && typeof (x as { note?: unknown }).note === 'string' ? (x as { note: string }).note : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();
    return s || undefined;
  }
  return undefined;
}

/** The tag from a `releases/latest` redirect (`…/releases/tag/<tag>`), or null (no release yet → `…/releases`). */
export function tagFromLocation(location: string, base: string): string | null {
  const path = new URL(location, base).pathname;
  const m = /\/releases\/tag\/([^/]+)\/?$/.exec(path);
  if (!m) return null;
  const tag = decodeURIComponent(m[1]!);
  if (!TAG.test(tag)) throw new MirrorError(`unexpected release tag: ${tag.slice(0, 80)}`);
  return tag;
}

function parseUpdateInfo(name: string, bytes: Buffer): UpdateInfo {
  let doc: unknown;
  try {
    doc = parseYaml(bytes.toString('utf8'));
  } catch (e) {
    throw new MirrorError(`${name}: not valid YAML (${(e as Error).message.split('\n')[0]})`);
  }
  if (!doc || typeof doc !== 'object') throw new MirrorError(`${name}: not an update info file`);
  const d = doc as { version?: unknown; files?: unknown; releaseNotes?: unknown };
  const version = parseVersion(d.version);
  if (!version) throw new MirrorError(`${name}: version is not a SemVer such as 0.1.0-alpha.1`);
  if (!Array.isArray(d.files) || !d.files.length) throw new MirrorError(`${name}: no files`);
  const files = d.files.map((f: unknown) => {
    const { url, sha512 } = (f ?? {}) as { url?: unknown; sha512?: unknown };
    if (typeof url !== 'string' || !classifyFile(url) || url.endsWith('.yml')) throw new MirrorError(`${name}: unsupported file ${String(url).slice(0, 120)}`);
    if (typeof sha512 !== 'string' || !sha512) throw new MirrorError(`${name}: ${url} has no sha512`);
    return { name: url, sha512 };
  });
  return { name, bytes, version, files, notes: notesText(d.releaseNotes) };
}

async function get(url: string, timeoutMs: number, redirect: 'follow' | 'manual' = 'follow'): Promise<Response> {
  try {
    return await fetch(url, { redirect, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new MirrorError(`${url}: ${(e as Error).message}`);
  }
}

const drop = (res: Response) => void res.body?.cancel().catch(() => {});

/** A mirror-created draft older than this is an interrupted import (the per-file limit is 30 min). */
export const STALE_DRAFT_MS = 45 * 60_000;

/** One sync run. Throws MirrorError / AppError on failure (the draft is already removed then). */
async function syncOnce(ctx: AppContext, cfg: AppMirrorConfig): Promise<Omit<MirrorRun, 'at'>> {
  const repoUrl = `${cfg.baseUrl}/${cfg.repo}`;
  const latest = await get(`${repoUrl}/releases/latest`, SMALL_TIMEOUT_MS, 'manual');
  drop(latest);
  const location = latest.headers.get('location');
  if (latest.status < 300 || latest.status >= 400 || !location) {
    throw new MirrorError(`releases/latest answered HTTP ${latest.status}${latest.status === 404 ? ' — check APP_MIRROR_GITHUB' : ''}`);
  }
  const tag = tagFromLocation(location, repoUrl);
  if (!tag) return { result: 'none', message: 'no published release on GitHub' };
  const download = (name: string) => `${repoUrl}/releases/download/${encodeURIComponent(tag)}/${name}`;

  const infos: UpdateInfo[] = [];
  for (const name of MIRROR_YMLS) {
    const res = await get(download(name), SMALL_TIMEOUT_MS);
    if (res.status === 404) {
      drop(res);
      continue;
    }
    if (!res.ok) {
      drop(res);
      throw new MirrorError(`${tag}/${name}: HTTP ${res.status}`);
    }
    infos.push(parseUpdateInfo(name, Buffer.from(await res.arrayBuffer())));
  }
  if (!infos.length) return { result: 'none', message: `${tag} has no latest*.yml` };
  const version = infos[0]!.version;
  const other = infos.find((i) => i.version !== version);
  if (other) throw new MirrorError(`${tag}: ${infos[0]!.name} says ${version} but ${other.name} says ${other.version}`);

  const [have] = await ctx.db.select().from(appReleases).where(eq(appReleases.version, version));
  if (have) {
    // A draft the mirror itself left behind (created_by NULL — the process stopped mid-import, e.g. a pod restart):
    // remove it and import again. Only after STALE_DRAFT_MS, so another server instance still importing is left
    // alone; drafts uploaded by an administrator (created_by set) are never touched.
    const stale = have.status === 'draft' && have.createdBy === null && ctx.clock.now().getTime() - have.createdAt.getTime() > STALE_DRAFT_MS;
    if (!stale) return { result: 'already', version };
    ctx.log.warn({ version }, 'app mirror: removing a draft left by an interrupted import');
    await deleteDraft(ctx, have);
  }
  // Never publish an older version over a newer one (e.g. a newer build uploaded by hand first): publishing
  // switches /updates/<channel>/latest*.yml to the most recently published release.
  const channel = channelOf(version);
  const published = await ctx.db
    .select({ version: appReleases.version })
    .from(appReleases)
    .where(and(eq(appReleases.channel, channel), eq(appReleases.status, 'published')));
  const newest = semver.maxSatisfying(published.map((r) => r.version), '*', { includePrerelease: true });
  if (newest && semver.lt(version, newest)) return { result: 'already', version, message: `older than the published ${newest}` };

  let release: ReleaseRow;
  try {
    release = await createRelease(ctx, null, version, (infos.find((i) => i.notes)?.notes ?? '').slice(0, MAX_NOTES));
  } catch (e) {
    // Another server instance created it between the check and here.
    if (e instanceof AppError && e.code === 'VERSION_EXISTS') return { result: 'already', version };
    throw e;
  }
  try {
    const saved = new Map<string, string>();
    const fetchInto = async (name: string, timeoutMs: number, optional: boolean): Promise<string | null> => {
      const res = await get(download(name), timeoutMs);
      if (optional && res.status === 404) {
        drop(res);
        return null;
      }
      if (!res.ok || !res.body) {
        drop(res);
        throw new MirrorError(`${tag}/${name}: HTTP ${res.status}`);
      }
      if (Number(res.headers.get('content-length') ?? 0) > MAX_FILE_BYTES) {
        drop(res);
        throw new MirrorError(`${tag}/${name}: larger than ${MAX_FILE_BYTES} bytes`);
      }
      const out = await saveReleaseFile(ctx, release, name, Readable.fromWeb(res.body as WebReadableStream<Uint8Array>));
      saved.set(name, out.sha512);
      return out.sha512;
    };
    for (const info of infos) {
      for (const f of info.files) {
        const sha = saved.get(f.name) ?? (await fetchInto(f.name, FILE_TIMEOUT_MS, false));
        if (sha !== f.sha512) throw new MirrorError(`${f.name}: sha512 differs from ${info.name}`);
        const blockmap = `${f.name}.blockmap`;
        if (!saved.has(blockmap) && classifyFile(blockmap)) await fetchInto(blockmap, SMALL_TIMEOUT_MS * 4, true);
      }
      await saveReleaseFile(ctx, release, info.name, Readable.from([info.bytes]));
    }
    await publishRelease(ctx, release);
  } catch (e) {
    await deleteDraft(ctx, release).catch((err: Error) => ctx.log.warn({ err: { message: err.message }, version }, 'app mirror: draft cleanup failed'));
    throw e;
  }
  return { result: 'published', version, message: `${tag}: ${infos.map((i) => i.name).join(' · ')}` };
}

/** Mirror state for one server process: single-flight runs, last result, timers. */
export class AppMirror {
  private current: Promise<void> | null = null;
  private lastRun: MirrorRun | null = null;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly ctx: AppContext,
    readonly config: AppMirrorConfig,
  ) {}

  status(): AppMirrorStatusDto {
    return { repo: this.config.repo, running: this.current !== null, lastRun: this.lastRun };
  }

  /** Sync now; a call while a run is in progress waits for that run instead of starting another. */
  async run(): Promise<AppMirrorStatusDto> {
    this.current ??= this.syncAndRecord().finally(() => {
      this.current = null;
    });
    await this.current;
    return this.status();
  }

  private async syncAndRecord(): Promise<void> {
    const at = this.ctx.clock.now().toISOString();
    try {
      const r = await syncOnce(this.ctx, this.config);
      this.lastRun = { at, ...r };
      if (r.result === 'published') this.ctx.log.info({ repo: this.config.repo, version: r.version }, 'app mirror: release imported and published');
      else this.ctx.log.debug({ repo: this.config.repo, ...r }, 'app mirror: nothing to import');
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      this.lastRun = { at, result: 'error', message };
      this.ctx.log.warn({ repo: this.config.repo, err: { message } }, 'app mirror: sync failed');
    }
  }

  /** First run MIRROR_START_DELAY_MS after start, then every interval. */
  start(): void {
    if (this.timers.length) return;
    const tick = () => void this.run();
    const first = setTimeout(() => {
      tick();
      const every = setInterval(tick, this.config.intervalMs);
      every.unref();
      this.timers.push(every);
    }, MIRROR_START_DELAY_MS);
    first.unref();
    this.timers.push(first);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
