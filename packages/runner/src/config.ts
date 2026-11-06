// Runner configuration from environment variables (k8s: ConfigMap + Secret).
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export interface RunnerConfig {
  /** Server internal API base URL (INTERNAL_PORT listener), e.g. http://euta-server:8081. */
  serverUrl: string;
  /** Shared runner token (k8s Secret). Never passed to the engine child process. */
  token: string;
  runnerId: string;
  /** Location label recorded on runs; baselines are kept per (environment, location). */
  location: string;
  /** Concurrent runs (SPEC: default 4, dev 2). */
  concurrency: number;
  /** Parent directory for per-run temp folders. */
  workDir: string;
  /** Engine CLI entry (`@euta/cli` dist/index.js). */
  cliPath: string;
  /** Claim long-poll length. */
  claimWaitMs: number;
  /** SIGTERM → SIGKILL grace when stopping the engine. */
  killGraceMs: number;
  /** Event batch: flush after this many events or this long. */
  batchMax: number;
  batchIntervalMs: number;
  /** Result upload attempts (with backoff) before the run is reported as upload-failed (→ aborted). */
  uploadAttempts: number;
  retryBaseMs: number;
}

// Dev default: the sibling euta-engine checkout (packages/runner/dist → ../../../../euta-engine).
const DEV_CLI = fileURLToPath(new URL('../../../../euta-engine/packages/cli/dist/index.js', import.meta.url));

export function loadRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const serverUrl = env.EUTA_SERVER_URL;
  const token = env.EUTA_RUNNER_TOKEN;
  if (!serverUrl) throw new Error('EUTA_SERVER_URL is required (server internal API, e.g. http://localhost:8081)');
  if (!token) throw new Error('EUTA_RUNNER_TOKEN is required');
  return {
    serverUrl: serverUrl.replace(/\/$/, ''),
    token,
    runnerId: env.RUNNER_ID ?? `${hostname().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60)}-${randomBytes(3).toString('hex')}`,
    location: env.RUNNER_LOCATION ?? 'local',
    concurrency: Math.max(1, Number(env.RUNNER_CONCURRENCY ?? 4)),
    workDir: env.RUNNER_WORK_DIR ?? tmpdir(),
    cliPath: env.EUTA_CLI ?? DEV_CLI,
    claimWaitMs: Number(env.RUNNER_CLAIM_WAIT_MS ?? 20_000),
    killGraceMs: Number(env.RUNNER_KILL_GRACE_MS ?? 10_000),
    batchMax: 50,
    batchIntervalMs: 1_000,
    uploadAttempts: Number(env.RUNNER_UPLOAD_ATTEMPTS ?? 4),
    retryBaseMs: 1_000,
  };
}
