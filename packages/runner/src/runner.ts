// The long-running runner loop: claim (long-poll, woken by the server's NOTIFY) while there are free
// slots → execute runs concurrently → on shutdown stop claiming and wait for running runs.
import type { ClaimedRun } from '@euta-cloud/shared';
import { ServerClient } from './client.js';
import type { RunnerConfig } from './config.js';
import { executeRun, type RunOutcome } from './execute.js';
import { jsonLogger, type Logger } from './log.js';

export interface RunnerHandle {
  readonly active: number;
  /** Outcomes of finished runs (tests). */
  readonly outcomes: RunOutcome[];
  /** Stop claiming; graceful → wait for running runs, otherwise kill them without reporting (crash). */
  stop(opts?: { graceful?: boolean }): Promise<void>;
  /** Resolves when `n` runs have finished in total. */
  waitForOutcomes(n: number): Promise<RunOutcome[]>;
}

export function startRunner(cfg: RunnerConfig, log: Logger = jsonLogger()): RunnerHandle {
  const client = new ServerClient(cfg);
  const running = new Map<string, Promise<void>>();
  const outcomes: RunOutcome[] = [];
  const outcomeWaiters: (() => void)[] = [];
  let stopping = false;
  const claimAbort = new AbortController();
  const crash = new AbortController();
  let slotFreed: () => void = () => {};

  const launch = (run: ClaimedRun) => {
    const p = executeRun(run, { cfg, client, log, crash: crash.signal })
      .catch((e: Error) => {
        log.error('run failed in the runner', { runId: run.runId, err: e.message });
        return { runId: run.runId, status: 'error' } as RunOutcome;
      })
      .then((o) => {
        outcomes.push(o);
        for (const w of outcomeWaiters.splice(0)) w();
      })
      .finally(() => {
        running.delete(run.runId);
        slotFreed();
      });
    running.set(run.runId, p);
  };

  const loop = (async () => {
    log.info('runner started', { runnerId: cfg.runnerId, location: cfg.location, concurrency: cfg.concurrency, server: cfg.serverUrl });
    while (!stopping) {
      const free = cfg.concurrency - running.size;
      if (free <= 0) {
        await new Promise<void>((r) => (slotFreed = r));
        continue;
      }
      try {
        const run = await client.claim(cfg.location, free, cfg.claimWaitMs, claimAbort.signal);
        if (run && !stopping) {
          log.info('run claimed', { runId: run.runId });
          launch(run);
        }
      } catch (e) {
        if (stopping) break;
        log.warn('claim failed — retrying', { err: (e as Error).message });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();

  return {
    get active() {
      return running.size;
    },
    outcomes,
    async stop({ graceful = true } = {}) {
      stopping = true;
      claimAbort.abort();
      slotFreed();
      if (!graceful) crash.abort();
      await loop;
      log.info('runner stopping — waiting for running runs', { active: running.size });
      await Promise.all(running.values());
      log.info('runner stopped');
    },
    async waitForOutcomes(n) {
      while (outcomes.length < n) await new Promise<void>((r) => outcomeWaiters.push(r));
      return outcomes;
    },
  };
}
