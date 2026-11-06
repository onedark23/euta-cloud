// Test set report data (ADR-032): `GET /runs/:runId/suite-report` of a set run — previous run of the same
// set + environment, comparison buckets, failing step sentence (pinned script text), error, screenshot
// path from the child's run.json; not for script runs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareChildren, failingStepId } from '../src/services/suite-report.js';
import { TestEnv } from './helpers.js';
import { FakeRunner, makeTar, projectFixture, requestRun, saveScript, SIMPLE_SCRIPT, type ProjectFixture } from './run-helpers.js';

describe('test set report', () => {
  let env: TestEnv;
  let f: ProjectFixture;
  let suiteId = '';
  beforeAll(async () => {
    env = await TestEnv.create();
    f = await projectFixture(env);
    await saveScript(env, f, 'a.yaml', SIMPLE_SCRIPT('A'));
    await saveScript(env, f, 'b.yaml', SIMPLE_SCRIPT('B', '  - click: { target: { role: button, name: 로그인 } }\n'));
    const ids = await Promise.all(['a.yaml', 'b.yaml'].map(async (p) => (await env.req('GET', `/api/projects/${f.pid}/scripts/${p}`, { cookie: f.owner.cookie })).body.id));
    suiteId = (await env.req('POST', `/api/projects/${f.pid}/suites`, { cookie: f.owner.cookie, body: { name: 'Smoke', scriptIds: ids } })).body.id;
  });
  afterAll(async () => env?.close());

  /** One child: passes, or fails at step 2 (with a screenshot in run.json). */
  async function finishChild(r: FakeRunner, id: string, ok: boolean) {
    const steps = ok
      ? [{ type: 'step.finished', seq: 2, stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 5 }]
      : [
          { type: 'step.finished', seq: 2, stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 5 },
          { type: 'step.finished', seq: 3, stepId: '2', index: 1, action: 'click', status: 'failed', durationMs: 7, error: 'locator not found: role=button name=로그인' },
        ];
    await r.events(id, [{ type: 'run.started', seq: 1 }, ...steps, { type: 'run.finished', seq: 9, status: ok ? 'passed' : 'failed', summary: { total: 2, passed: ok ? 2 : 1, failed: ok ? 0 : 1, error: 0, skipped: 0 }, durationMs: 20 }]);
    const runJson = { steps: [{ stepId: '1', status: 'passed', screenshot: 'screenshots/001-1-goto.png' }, { stepId: '2', status: ok ? 'passed' : 'failed', screenshot: 'screenshots/002-2-click.png' }] };
    await r.upload(id, await makeTar([{ name: 'run.json', body: JSON.stringify(runJson) }, { name: 'screenshots/002-2-click.png', body: Buffer.from([0x89, 0x50]) }]));
    await r.finish(id, { status: ok ? 'passed' : 'failed' });
  }

  async function runSet(outcomes: [boolean, boolean]): Promise<string> {
    const run = (await requestRun(env, f, { suiteId })).body;
    const r = new FakeRunner(env);
    for (const ok of outcomes) {
      const c = await r.claim(1);
      await finishChild(r, c.body.runId, ok);
    }
    return run.id as string;
  }

  it('first run: no previous run; the failed child shows its step sentence, error and screenshot', async () => {
    const id = await runSet([true, false]);
    const rep = await env.req('GET', `/api/projects/${f.pid}/runs/${id}/suite-report`, { cookie: f.viewer.cookie });
    expect(rep.status).toBe(200);
    expect(rep.body.previous).toBeNull();
    expect(rep.body.comparison).toBeNull();
    expect(rep.body.failures).toHaveLength(1);
    expect(rep.body.failures[0]).toMatchObject({ order: 2, path: 'b.yaml', status: 'failed', stepId: '2', error: 'locator not found: role=button name=로그인', screenshot: 'screenshots/002-2-click.png' });
    expect(rep.body.failures[0].sentence).toContain('로그인');
    expect(Object.values(rep.body.names)).toEqual(['A', 'B']);
  });

  it('second run: compared with the previous run of the same set and environment', async () => {
    const first = (await env.req('GET', `/api/projects/${f.pid}/runs?target=${suiteId}`, { cookie: f.viewer.cookie })).body.runs[0].id;
    const id = await runSet([false, true]);
    const rep = (await env.req('GET', `/api/projects/${f.pid}/runs/${id}/suite-report`, { cookie: f.viewer.cookie })).body;
    expect(rep.previous).toMatchObject({ id: first, status: 'failed' });
    expect(rep.comparison).toEqual({ newlyFailing: [{ order: 1, path: 'a.yaml' }], recovered: [{ order: 2, path: 'b.yaml' }], stillFailing: [], stillPassing: [] });
    expect(rep.failures.map((x: { path: string }) => x.path)).toEqual(['a.yaml']);
  });

  it('lists the children\'s manual steps (reached or not) with the step title from the pinned script', async () => {
    const extra = "  - manual: { instruction: 로고 색 확인, reason: 사람 판단 }\n  - click: { target: { role: button, name: 로그인 } }\n  - name: 메일\n    manual: 결제 메일 확인\n";
    await saveScript(env, f, 'm.yaml', SIMPLE_SCRIPT('M', extra));
    const ids = await Promise.all(['a.yaml', 'm.yaml'].map(async (p) => (await env.req('GET', `/api/projects/${f.pid}/scripts/${p}`, { cookie: f.owner.cookie })).body.id));
    const sid = (await env.req('POST', `/api/projects/${f.pid}/suites`, { cookie: f.owner.cookie, body: { name: 'Manual', scriptIds: ids } })).body.id;
    const run = (await requestRun(env, f, { suiteId: sid })).body;
    const r = new FakeRunner(env);
    await finishChild(r, (await r.claim(1)).body.runId, true);
    const m = (await r.claim(1)).body.runId;
    await r.events(m, [
      { type: 'run.started', seq: 1 },
      { type: 'step.finished', seq: 2, stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 5 },
      { type: 'step.finished', seq: 3, stepId: '2', index: 1, action: 'manual', status: 'skipped', durationMs: 0, manual: { instruction: '로고 색 확인', reason: '사람 판단' } },
      { type: 'step.finished', seq: 4, stepId: '3', index: 2, action: 'click', status: 'failed', durationMs: 7, error: 'locator not found' },
      { type: 'step.finished', seq: 5, stepId: '4', index: 3, action: 'manual', status: 'skipped', durationMs: 0, error: 'skipped after step 3 failed', manual: { instruction: '결제 메일 확인' } },
    ]);
    await r.complete(m, 'failed');
    const rep = (await env.req('GET', `/api/projects/${f.pid}/runs/${run.id}/suite-report`, { cookie: f.viewer.cookie })).body;
    expect(rep.manual).toEqual([
      { runId: m, order: 2, path: 'm.yaml', stepId: '2', title: null, instruction: '로고 색 확인', reason: '사람 판단', reached: true },
      { runId: m, order: 2, path: 'm.yaml', stepId: '4', title: '메일', instruction: '결제 메일 확인', reason: null, reached: false },
    ]);
    expect(rep.failures.map((x: { stepId: string }) => x.stepId)).toEqual(['3']);
  });

  it('script runs have no set report', async () => {
    const run = (await requestRun(env, f, { scriptPath: 'a.yaml' })).body;
    const rep = await env.req('GET', `/api/projects/${f.pid}/runs/${run.id}/suite-report`, { cookie: f.viewer.cookie });
    expect(rep.status).toBe(422);
    const r = new FakeRunner(env);
    await r.complete((await r.claim(1)).body.runId);
  });

  it('compareChildren / failingStepId', () => {
    const c = (scriptId: string, status: string) => ({ scriptId, scriptPath: `${scriptId}.yaml`, status });
    // Changed plan → script + occurrence.
    expect(compareChildren([c('x', 'failed'), c('a', 'passed'), c('a', 'failed')], [c('a', 'failed'), c('a', 'passed')])).toEqual({
      newlyFailing: [{ order: 1, path: 'x.yaml' }, { order: 3, path: 'a.yaml' }],
      recovered: [{ order: 2, path: 'a.yaml' }],
      stillFailing: [],
      stillPassing: [],
    });
    expect(compareChildren([c('a', 'cancelled'), c('b', 'timeout')], [c('a', 'passed'), c('b', 'error')])).toEqual({ newlyFailing: [], recovered: [], stillFailing: [{ order: 2, path: 'b.yaml' }], stillPassing: [] });
    expect(failingStepId([{ stepId: '1', status: 'passed' }, { stepId: '2', status: 'failed' }, { stepId: '2.1', status: 'passed' }, { stepId: '2.2', status: 'failed' }, { stepId: '3', status: 'error' }])).toBe('2.2');
    expect(failingStepId([{ stepId: '1', status: 'passed' }])).toBeUndefined();
  });
});
