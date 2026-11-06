// Tar helpers: pack a result folder for upload (regular files only — symlinks are skipped), and
// unpack baselines from the server into a temp dir with the same path rules as the server.
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar-stream';

/** Every regular file under `dir` as a relative `/` path (symlinks and special files skipped). */
export async function listFiles(dir: string, base = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, base), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

/** Tar stream of the given files under `dir` (all regular files when omitted; `dir` null → empty tar). */
export function packFiles(dir: string | null, files?: string[]): Readable {
  const pack = tar.pack();
  (async () => {
    if (dir) {
      for (const rel of files ?? (await listFiles(dir))) {
        const full = join(dir, rel);
        const st = await lstat(full);
        if (!st.isFile()) continue;
        await new Promise<void>((ok, fail) => {
          const entry = pack.entry({ name: rel, size: st.size, mode: 0o644, mtime: st.mtime }, (err) => (err ? fail(err) : ok()));
          createReadStream(full).on('error', fail).pipe(entry);
        });
      }
    }
    pack.finalize();
  })().catch((err: Error) => pack.destroy(err));
  return Readable.from(pack);
}

function safeRel(raw: string): string | null {
  let p = raw.replace(/^(\.\/)+/, '');
  if (p.endsWith('/')) p = p.slice(0, -1);
  if (!p || /[\u0000-\u001f\u007f\\]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  return p.split('/').some((s) => s === '' || s === '.' || s === '..') ? null : p;
}

/** Unpack regular files of a tar stream into `dir`; unsafe entries are skipped. Returns file paths. */
export async function unpackTo(body: Readable, dir: string): Promise<string[]> {
  const root = resolve(dir);
  const extract = tar.extract();
  body.pipe(extract as unknown as NodeJS.WritableStream);
  const out: string[] = [];
  for await (const entry of extract) {
    const rel = entry.header.type === 'file' ? safeRel(entry.header.name) : null;
    const full = rel ? resolve(root, ...rel.split('/')) : null;
    if (!rel || !full || !full.startsWith(root + sep)) {
      entry.resume();
      continue;
    }
    await mkdir(dirname(full), { recursive: true });
    await pipeline(Readable.from(entry), createWriteStream(full));
    out.push(rel);
  }
  return out;
}
