// Streaming tar extraction for runner uploads (ADR-021 §3). Each entry is validated before
// anything is written: only regular files and directories, relative paths without `..`, and a
// total size cap. Any violation aborts the whole upload (the caller deletes partial files).
import { Readable, Transform } from 'node:stream';
import * as tar from 'tar-stream';
import { AppError } from '../http.js';
import { safeRelPath } from './result-store.js';

export class TarRejected extends AppError {
  constructor(message: string) {
    super(422, 'TAR_REJECTED', message);
  }
}

export class TarTooLarge extends AppError {
  constructor(max: number) {
    super(413, 'PAYLOAD_TOO_LARGE', `result upload is larger than ${max} bytes`);
  }
}

/** Header slack on top of the content cap (512-byte headers + padding + pax records). */
const TAR_OVERHEAD = 16 * 1024 * 1024;

/**
 * Read a tar stream and hand each file to `onFile(relPath, stream)` in order.
 * Returns the number of files and content bytes.
 */
export async function extractTar(
  body: Readable,
  maxBytes: number,
  onFile: (relPath: string, data: Readable) => Promise<unknown>,
): Promise<{ files: number; bytes: number }> {
  let raw = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      raw += chunk.length;
      if (raw > maxBytes + TAR_OVERHEAD) cb(new TarTooLarge(maxBytes));
      else cb(null, chunk);
    },
  });
  const extract = tar.extract();
  body.on('error', (e) => limiter.destroy(e));
  limiter.on('error', (e) => extract.destroy(e));
  body.pipe(limiter).pipe(extract);

  let files = 0;
  let bytes = 0;
  try {
    for await (const entry of extract) {
      const h = entry.header;
      if (h.type === 'directory') {
        if (!safeRelPath(h.name)) throw new TarRejected(`unsafe path in upload: ${JSON.stringify(h.name)}`);
        entry.resume();
        continue;
      }
      if (h.type !== 'file' && h.type !== 'contiguous-file') {
        throw new TarRejected(`unsupported entry type "${h.type}" in upload (${JSON.stringify(h.name)}) — only files and directories`);
      }
      const rel = safeRelPath(h.name);
      if (!rel) throw new TarRejected(`unsafe path in upload: ${JSON.stringify(h.name)}`);
      bytes += h.size ?? 0;
      if (bytes > maxBytes) throw new TarTooLarge(maxBytes);
      // tar-stream entries are streamx streams; adapt to a Node Readable for fs pipelines.
      await onFile(rel, Readable.from(entry));
      files++;
    }
  } catch (e) {
    body.unpipe?.();
    body.resume();
    throw e;
  }
  return { files, bytes };
}
