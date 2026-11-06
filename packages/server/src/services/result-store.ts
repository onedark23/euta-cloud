// Result file storage (ADR-021). The server is the only writer: runners upload a tar through the
// internal API, web/app download through the public API (with permission checks).
// Layout: `<root>/<projectId>/<runId>/…` (engine run folder as-is) and
// `<root>/<projectId>/baselines/<envId>/<location>/…` (visual baselines, never cleaned up).
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface StoredFile {
  path: string;
  size: number;
}

export interface ResultStore {
  /** Write one file of a run (parents created). Returns bytes written. */
  put(projectId: string, runId: string, relPath: string, data: Readable): Promise<number>;
  /** Open a stored file, or null when missing / not a regular file. */
  get(projectId: string, runId: string, relPath: string): Promise<{ stream: Readable; size: number } | null>;
  list(projectId: string, runId: string): Promise<StoredFile[]>;
  deleteRun(projectId: string, runId: string): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  /** Add a baseline file unless one already exists (baselines are never overwritten by runs). */
  putBaseline(projectId: string, envId: string, location: string, relPath: string, data: Readable): Promise<boolean>;
  listBaselines(projectId: string, envId: string, location: string): Promise<StoredFile[]>;
  getBaseline(projectId: string, envId: string, location: string, relPath: string): Promise<{ stream: Readable; size: number } | null>;
}

const ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Validate a relative path from a tar entry or URL: forward slashes, no absolute / drive paths,
 * no `.`/`..`/empty segments, no control characters. Returns the cleaned path or null.
 */
export function safeRelPath(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.replace(/^(\.\/)+/, '');
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (!p || p.length > 1000) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return null;
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return null;
  return p;
}

/** Path label for the runner location (`dev 클러스터` → safe directory name). */
export function locationDir(location: string): string {
  const s = location
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || 'default';
}

async function walk(root: string, base = ''): Promise<StoredFile[]> {
  let entries;
  try {
    entries = await readdir(join(root, base), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: StoredFile[] = [];
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walk(root, rel)));
    else if (e.isFile()) out.push({ path: rel, size: (await stat(join(root, rel))).size });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export class FsResultStore implements ResultStore {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private dir(...ids: string[]): string {
    for (const id of ids) if (!ID.test(id)) throw new Error('invalid id for result path');
    return join(this.root, ...ids);
  }

  private within(base: string, relPath: string): string {
    const rel = safeRelPath(relPath);
    if (!rel) throw new Error('invalid result file path');
    const full = resolve(base, ...rel.split('/'));
    if (!full.startsWith(base + sep)) throw new Error('invalid result file path');
    return full;
  }

  private baseDir(projectId: string, envId: string, location: string): string {
    return join(this.dir(projectId, 'baselines', envId), locationDir(location));
  }

  private async open(full: string) {
    try {
      const st = await lstat(full);
      if (!st.isFile()) return null;
      return { stream: createReadStream(full), size: st.size };
    } catch {
      return null;
    }
  }

  async put(projectId: string, runId: string, relPath: string, data: Readable): Promise<number> {
    const full = this.within(this.dir(projectId, runId), relPath);
    await mkdir(dirname(full), { recursive: true });
    let n = 0;
    data.on('data', (c: Buffer) => (n += c.length));
    await pipeline(data, createWriteStream(full, { flags: 'wx' }));
    return n;
  }

  async get(projectId: string, runId: string, relPath: string) {
    let full: string;
    try {
      full = this.within(this.dir(projectId, runId), relPath);
    } catch {
      return null;
    }
    return this.open(full);
  }

  list(projectId: string, runId: string): Promise<StoredFile[]> {
    return walk(this.dir(projectId, runId));
  }

  async deleteRun(projectId: string, runId: string): Promise<void> {
    await rm(this.dir(projectId, runId), { recursive: true, force: true });
  }

  async deleteProject(projectId: string): Promise<void> {
    await rm(this.dir(projectId), { recursive: true, force: true });
  }

  async putBaseline(projectId: string, envId: string, location: string, relPath: string, data: Readable): Promise<boolean> {
    const full = this.within(this.baseDir(projectId, envId, location), relPath);
    await mkdir(dirname(full), { recursive: true });
    try {
      await pipeline(data, createWriteStream(full, { flags: 'wx' }));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
        data.resume();
        return false;
      }
      throw e;
    }
  }

  listBaselines(projectId: string, envId: string, location: string): Promise<StoredFile[]> {
    return walk(this.baseDir(projectId, envId, location));
  }

  async getBaseline(projectId: string, envId: string, location: string, relPath: string) {
    return this.open(this.within(this.baseDir(projectId, envId, location), relPath));
  }
}
