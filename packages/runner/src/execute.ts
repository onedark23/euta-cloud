// One run, end to end (SPEC 러너 프로토콜 · ARCH 실행 흐름): fresh temp dir → baselines → one-time
// credentials into a 0600 secrets file (deleted as soon as the engine has read it) → `euta run
// --cloud --allowed-domains …` child process with a clean environment → steps.jsonl tailed to the
// server in batches (lease renewal + stop signal) → SIGTERM/SIGKILL on cancel/time limit → tar
// upload with retries → finish → temp dir removed.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { ClaimedRun, FinishRequest, RunSummaryDto } from '@euta-cloud/shared';
import { HttpError, type ServerClient } from './client.js';
import type { RunnerConfig } from './config.js';
import { redactor, type Logger } from './log.js';
import { listFiles, packFiles, unpackTo } from './tar.js';

export interface ExecuteDeps {
  cfg: RunnerConfig;
  client: ServerClient;
  log: Logger;
  /** Aborted → simulate a crash: kill the engine and report nothing (tests, forced shutdown). */
  crash?: AbortSignal;
}

export interface RunOutcome {
  runId: string;
  status: FinishRequest['status'] | 'lease-lost' | 'crashed';
}

/** Environment keys the run environment may not set (they would change how the child process runs). */
const RESERVED_ENV = /^(PATH|HOME|TMPDIR|TMP|TEMP|SHELL|USER|LOGNAME|LANG|LC_.*|NODE_.*|NPM_.*|LD_.*|DYLD_.*|PLAYWRIGHT_.*|EUTA_.*|UV_.*|SSL_.*|OPENSSL_.*)$/i;

/**
 * The engine child's environment: only what Node/Playwright need plus the run environment
 * (`BASE_URL` + environment variables). The runner's own variables (token, server URL) are never
 * inherited — the engine reads `${env.*}` (and the secrets fallback) from its process env.
 */
export function childEnv(run: ClaimedRun, tmp: string): { env: NodeJS.ProcessEnv; dropped: string[] } {
  const env: NodeJS.ProcessEnv = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(run.environment.vars)) {
    if (RESERVED_ENV.test(k)) dropped.push(k);
    else env[k] = v;
  }
  env.BASE_URL = run.environment.baseUrl;
  env.PATH = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  env.HOME = process.env.HOME ?? tmp;
  env.TMPDIR = join(tmp, 'tmp');
  env.LANG = process.env.LANG ?? 'C.UTF-8';
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
  env.EUTA_OS_INPUT = '0';
  return { env, dropped };
}

export function engineArgs(run: ClaimedRun, paths: { script: string; runsDir: string; baselineDir: string; secrets: string | null }): string[] {
  const args = ['run', paths.script, '--runs-dir', paths.runsDir, '--baseline-dir', paths.baselineDir, '--cloud', '--quiet'];
  if (paths.secrets) args.push('--secrets', paths.secrets);
  if (run.environment.allowedDomains.length) args.push('--allowed-domains', run.environment.allowedDomains.join(','));
  if (run.browser) args.push('--browser', run.browser);
  if (run.device) args.push('--device', run.device);
  for (const [k, v] of Object.entries(run.vars)) args.push('--var', `${k}=${String(v)}`);
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safeName = (n: string) => (/^[A-Za-z0-9._-]{1,120}\.ya?ml$/i.test(n) ? n : 'script.yaml');

async function retry<T>(attempts: number, baseMs: number, fn: () => Promise<T>, giveUp: (e: unknown) => boolean): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (giveUp(e) || i === attempts - 1) break;
      await sleep(baseMs * 2 ** i);
    }
  }
  throw last;
}

const leaseLost = (e: unknown) => e instanceof HttpError && (e.status === 409 || e.status === 404);

export async function executeRun(run: ClaimedRun, deps: ExecuteDeps): Promise<RunOutcome> {
  const { cfg, client, log } = deps;
  const tag = { runId: run.runId };
  const tmp = await mkdtemp(join(cfg.workDir, 'euta-run-'));
  let redact = (s: string) => s;
  try {
    const runsDir = join(tmp, 'runs');
    const baselineDir = join(tmp, 'baselines');
    await Promise.all([mkdir(runsDir), mkdir(baselineDir), mkdir(join(tmp, 'tmp'))]);
    const script = join(tmp, safeName(run.scriptName));
    await writeFile(script, run.scriptSource);

    // Baselines of (environment, location) — a failure only means they get re-created.
    let baselinesBefore = new Set<string>();
    try {
      const body = await client.downloadBaselines(run.runId);
      if (body) baselinesBefore = new Set(await unpackTo(Readable.fromWeb(body as never), baselineDir));
    } catch (e) {
      if (leaseLost(e)) return { ...tag, status: 'lease-lost' };
      log.warn('baseline download failed', { ...tag, err: (e as Error).message });
    }

    // One-time credentials → 0600 file, deleted once the engine has read it.
    let secretsFile: string | null = null;
    if (run.credentialNames.length) {
      let secrets: Record<string, string>;
      try {
        secrets = await client.credentials(run.runId);
      } catch (e) {
        if (leaseLost(e)) return { ...tag, status: 'lease-lost' };
        throw e;
      }
      redact = redactor(Object.values(secrets));
      secretsFile = join(tmp, 'secrets.json');
      await writeFile(secretsFile, JSON.stringify(secrets), { mode: 0o600, flag: 'wx' });
    }
    const dropSecrets = async () => {
      if (!secretsFile) return;
      const f = secretsFile;
      secretsFile = null;
      await rm(f, { force: true });
    };

    const { env, dropped } = childEnv(run, tmp);
    if (dropped.length) log.warn('environment variables not passed to the engine (reserved names)', { ...tag, names: dropped });
    const args = engineArgs(run, { script, runsDir, baselineDir, secrets: secretsFile });
    log.info('engine starting', { ...tag, location: cfg.location, timeLimitMs: run.timeLimitMs });
    const child: ChildProcess = spawn(process.execPath, [cfg.cliPath, ...args], { cwd: tmp, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    const keep = (c: Buffer) => {
      stderrTail = (stderrTail + c.toString('utf8')).slice(-8000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const exited = new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
      child.on('error', (err) => {
        stderrTail += `\n${err.message}`;
        resolve(null);
      });
    });

    // ── Stop handling (cancel / timeout / crash)
    let stopReason: 'cancel' | 'timeout' | null = null;
    let lost = false;
    let killTimer: NodeJS.Timeout | null = null;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    };
    const stop = (reason: 'cancel' | 'timeout' | null, hard = false) => {
      if (reason && !stopReason) stopReason = reason;
      if (hard) return killGroup('SIGKILL');
      if (killTimer) return;
      log.info('stopping engine', { ...tag, reason });
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), cfg.killGraceMs);
    };
    const limitTimer = setTimeout(() => stop('timeout'), run.timeLimitMs);
    const onCrash = () => {
      lost = true;
      stop(null, true);
    };
    deps.crash?.addEventListener('abort', onCrash);

    // ── Tail steps.jsonl → batches
    let runDir: string | null = null;
    let engineRunId: string | undefined;
    let offset = 0;
    let partial = '';
    const queue: Record<string, unknown>[] = [];
    let lastFlush = 0;
    let flushing: Promise<void> | null = null;
    const readNew = async () => {
      if (!runDir) {
        const dirs = (await readdir(runsDir, { withFileTypes: true }).catch(() => [])).filter((d) => d.isDirectory());
        if (!dirs.length) return;
        engineRunId = dirs[0]!.name;
        runDir = join(runsDir, engineRunId);
        // The CLI reads --secrets synchronously before it creates the run dir.
        await dropSecrets();
      }
      const file = join(runDir, 'steps.jsonl');
      if (!existsSync(file)) return;
      const fh = await open(file, 'r');
      try {
        for (;;) {
          const buf = Buffer.alloc(256 * 1024);
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
          if (!bytesRead) break;
          offset += bytesRead;
          partial += buf.subarray(0, bytesRead).toString('utf8');
        }
      } finally {
        await fh.close();
      }
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          queue.push(JSON.parse(l) as Record<string, unknown>);
        } catch {
          /* torn line — skip */
        }
      }
    };
    const flush = async (force = false) => {
      if (lost || deps.crash?.aborted) return;
      const due = queue.length >= cfg.batchMax || (queue.length > 0 && Date.now() - lastFlush >= cfg.batchIntervalMs) || Date.now() - lastFlush >= run.heartbeatMs;
      if (!force && !due) return;
      const batch = queue.slice(0, 500);
      try {
        const res = await client.events(run.runId, batch, engineRunId);
        queue.splice(0, batch.length);
        lastFlush = Date.now();
        if (res.stop) stop(res.stop);
      } catch (e) {
        if (leaseLost(e)) {
          log.warn('lease lost — abandoning the run', { ...tag, code: (e as HttpError).code });
          lost = true;
          stop(null);
        } else {
          log.warn('event batch failed (will retry)', { ...tag, err: redact((e as Error).message) });
          lastFlush = Date.now() - run.heartbeatMs + 1000;
        }
      }
    };
    const tick = setInterval(() => {
      if (flushing) return;
      flushing = (async () => {
        await readNew().catch(() => {});
        await flush();
      })().finally(() => {
        flushing = null;
      });
    }, 200);

    const code = await exited;
    clearInterval(tick);
    clearTimeout(limitTimer);
    if (killTimer) clearTimeout(killTimer);
    deps.crash?.removeEventListener('abort', onCrash);
    await flushing;
    await dropSecrets();
    if (deps.crash?.aborted) return { ...tag, status: 'crashed' };
    if (lost) return { ...tag, status: 'lease-lost' };
    await readNew().catch(() => {});
    for (let i = 0; i < 5 && queue.length && !lost; i++) {
      await flush(true);
      if (queue.length) await sleep(cfg.retryBaseMs);
    }
    if (lost) return { ...tag, status: 'lease-lost' };

    // ── Outcome
    let status: FinishRequest['status'] = 'error';
    let summary: RunSummaryDto | null = null;
    let durationMs: number | null = null;
    let error: string | null = null;
    const runJson = runDir ? join(runDir, 'run.json') : null;
    if (runJson && existsSync(runJson)) {
      try {
        const rj = JSON.parse(await readFile(runJson, 'utf8')) as { status?: string; summary?: RunSummaryDto; durationMs?: number; error?: string };
        if (rj.status === 'passed' || rj.status === 'failed' || rj.status === 'error') status = rj.status;
        summary = rj.summary ?? null;
        durationMs = rj.durationMs ?? null;
        if (rj.error) error = rj.error;
      } catch {
        error = 'run.json unreadable';
      }
    } else if (!stopReason) {
      error = `engine exited with code ${code ?? 'null'} without a result: ${redact(stderrTail.trim()).slice(-1500)}`;
    }
    if (stopReason === 'timeout') status = 'timeout';
    else if (stopReason === 'cancel') status = 'cancelled';

    // ── New baselines (existing ones are never replaced)
    if (status !== 'cancelled') {
      const created = (await listFiles(baselineDir)).filter((f) => !baselinesBefore.has(f));
      if (created.length) {
        await client.uploadBaselines(run.runId, packFiles(baselineDir, created)).catch((e: Error) => log.warn('baseline upload failed', { ...tag, err: e.message }));
      }
    }

    // ── Upload, then finish
    let uploadFailed = false;
    try {
      await retry(cfg.uploadAttempts, cfg.retryBaseMs, () => client.uploadResult(run.runId, packFiles(runDir)), leaseLost);
    } catch (e) {
      if (leaseLost(e)) return { ...tag, status: 'lease-lost' };
      uploadFailed = true;
      error = `${error ? `${error}; ` : ''}${redact((e as Error).message)}`;
      log.error('result upload failed', { ...tag, err: redact((e as Error).message) });
    }
    try {
      await retry(4, cfg.retryBaseMs, () => client.finish(run.runId, { status, summary, durationMs, error: error ? redact(error) : null, ...(uploadFailed ? { uploadFailed } : {}) }), leaseLost);
    } catch (e) {
      if (leaseLost(e)) return { ...tag, status: 'lease-lost' };
      log.error('finish failed — the server will abort the run when the lease expires', { ...tag, err: (e as Error).message });
    }
    log.info('run finished', { ...tag, status, exitCode: code });
    return { ...tag, status };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
