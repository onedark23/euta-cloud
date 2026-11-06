// Helpers for C3 tests: Asia/Seoul times, schedule creation, scheduler ticks and a fake runner that
// finishes the next claimable run with a given outcome (incl. a failed step).
import { tickSchedules } from '../src/services/scheduler.js';
import type { TestEnv } from './helpers.js';
import { FakeRunner, makeTar, type ProjectFixture } from './run-helpers.js';

/** `2026-11-02T09:00:00` (Seoul wall clock) → Date. */
export const kst = (s: string) => new Date(`${s}+09:00`);

export async function createSchedule(env: TestEnv, f: ProjectFixture, body: Record<string, unknown>, cookie = f.editor.cookie) {
  return env.req('POST', `/api/projects/${f.pid}/schedules`, { cookie, body });
}

export const tick = (env: TestEnv) => tickSchedules(env.ctx);

/** Claim the next run and drive it to `status` (failed/error → step 2 fails with an error). */
export async function finishNext(env: TestEnv, status: 'passed' | 'failed' | 'error' | 'timeout', runner = new FakeRunner(env)): Promise<string> {
  const c = await runner.claim();
  if (c.status !== 200) throw new Error(`nothing to claim (${c.status})`);
  const runId = c.body.runId as string;
  const failing = status !== 'passed';
  await runner.events(runId, [
    { type: 'step.started', seq: 1, stepId: '1', action: 'goto' },
    { type: 'step.finished', seq: 2, stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 5 },
    ...(failing ? [{ type: 'step.finished', seq: 3, stepId: '2', index: 1, action: 'fill', status: status === 'failed' ? 'failed' : 'error', durationMs: 7, error: 'element not found' }] : []),
    {
      type: 'run.finished',
      seq: 4,
      status: status === 'timeout' ? 'error' : status,
      summary: { total: 2, passed: failing ? 1 : 2, failed: status === 'failed' ? 1 : 0, error: status === 'error' ? 1 : 0, skipped: 0 },
      durationMs: 1234,
    },
  ]);
  const up = await runner.upload(runId, await makeTar([{ name: 'run.json', body: '{}' }]));
  if (up.status !== 200) throw new Error(`upload failed ${up.text}`);
  const fin = await runner.finish(runId, { status, durationMs: 1234 });
  if (fin.status !== 200) throw new Error(`finish failed ${fin.text}`);
  return runId;
}
