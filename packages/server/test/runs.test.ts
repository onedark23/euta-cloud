// Runs API + internal runner protocol against real Postgres, with a fake runner (SPEC 완료 기준 C1:
// precheck rejections, same-credential rule, cancel, lease expiry, time limit, result files,
// tar path traversal, permissions, retention).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeExpired } from '../src/services/purge.js';
import { purgeResults } from '../src/services/result-retention.js';
import { sweepRuns } from '../src/services/run-queue.js';
import { INVALID_SCRIPT, TestEnv, VALID_SCRIPT } from './helpers.js';
import { CRED_SCRIPT, FakeRunner, makeTar, projectFixture, requestRun, saveScript, SIMPLE_SCRIPT, type ProjectFixture } from './run-helpers.js';

const MIN = 60_000;

describe('run precheck', () => {
  let env: TestEnv;
  let f: ProjectFixture;
  beforeAll(async () => {
    env = await TestEnv.create();
    f = await projectFixture(env, { credentials: { USER_EMAIL: 'precheck-secret-value-1' } });
    await saveScript(env, f, 'ok.yaml', VALID_SCRIPT);
    await saveScript(env, f, 'os.yaml', SIMPLE_SCRIPT('Os', '  - click: { target: { text: A } }\n    input: os\n'));
    await saveScript(env, f, 'url-secret.yaml', SIMPLE_SCRIPT('UrlSecret', '  - goto: "/login?u=${secrets.USER_EMAIL}"\n'));
    await saveScript(env, f, 'missing.yaml', CRED_SCRIPT('NOPE_CRED'));
    await saveScript(env, f, 'invalid.yaml', INVALID_SCRIPT, 'external');
    await saveScript(env, f, 'needs-env.yaml', SIMPLE_SCRIPT('NeedsEnv', '  - goto: ${env.LANDING_PATH}\n'));
  });
  afterAll(async () => env?.close());

  const codeOf = async (scriptPath: string, extra: Record<string, unknown> = {}) => {
    const r = await requestRun(env, f, { scriptPath, ...extra });
    return { status: r.status, code: r.body?.error?.code, details: r.body?.error?.details, body: r.body };
  };

  it('accepts a valid script and records the credential names', async () => {
    const r = await requestRun(env, f, { scriptPath: 'ok.yaml' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'queued', kind: 'script', source: 'web', credentialNames: ['USER_EMAIL'], timeLimitSec: 21600, record: { video: 'on-failure', trace: 'on-failure' } });
    expect(r.body.script).toMatchObject({ path: 'ok.yaml', version: 1 });
  });

  it('rejects input: os', async () => {
    const r = await codeOf('os.yaml');
    expect(r).toMatchObject({ status: 422, code: 'OS_INPUT_NOT_ALLOWED' });
    expect(r.details[0].issues[0].path).toBe('steps[1].input');
  });

  it('rejects ${secrets.*} outside fill/type values (e.g. in a URL)', async () => {
    const r = await codeOf('url-secret.yaml');
    expect(r).toMatchObject({ status: 422, code: 'SECRET_PLACEMENT' });
    expect(r.details[0].issues[0].path).toBe('steps[1].goto');
  });

  it('rejects credential names missing from the environment', async () => {
    const r = await codeOf('missing.yaml');
    expect(r).toMatchObject({ status: 422, code: 'CREDENTIALS_MISSING' });
    expect(r.details[0].names).toEqual(['NOPE_CRED']);
  });

  it('rejects a script whose current version has validation errors', async () => {
    const r = await codeOf('invalid.yaml');
    expect(r).toMatchObject({ status: 422, code: 'SCRIPT_INVALID' });
  });

  it('validates ${env.*} against the run environment (env vars), not the server process env', async () => {
    process.env.LANDING_PATH = '/from-server-process';
    try {
      expect(await codeOf('needs-env.yaml')).toMatchObject({ status: 422, code: 'SCRIPT_INVALID' });
      await env.req('PATCH', `/api/projects/${f.pid}/environments/${f.envId}`, { cookie: f.owner.cookie, body: { vars: { LANDING_PATH: '/home' } } });
      expect((await codeOf('needs-env.yaml')).status).toBe(201);
    } finally {
      delete process.env.LANDING_PATH;
    }
  });

  it('rejects an environment URL that resolves to a private address', async () => {
    const e = await env.req('POST', `/api/projects/${f.pid}/environments`, { cookie: f.owner.cookie, body: { name: 'intra', baseUrl: 'https://intranet.example.com' } });
    const r = await codeOf('ok.yaml', { environmentId: e.body.id });
    expect(r.status).toBe(422);
    // Missing credential in the new env comes first, the address problem is in the list too.
    expect(r.details.map((p: { code: string }) => p.code)).toEqual(['CREDENTIALS_MISSING', 'TARGET_NOT_PUBLIC']);
    const loop = await env.req('POST', `/api/projects/${f.pid}/environments`, { cookie: f.owner.cookie, body: { name: 'loop', baseUrl: 'http://127.0.0.1:4173' } });
    expect(await codeOf('os.yaml', { environmentId: loop.body.id })).toMatchObject({ code: 'OS_INPUT_NOT_ALLOWED' });
    const r2 = await requestRun(env, f, { scriptPath: 'needs-env.yaml', environmentId: loop.body.id, vars: {} });
    expect(r2.body.error.details.map((p: { code: string }) => p.code)).toContain('TARGET_NOT_PUBLIC');
  });

  it('precheck-only endpoint lists every problem without queueing', async () => {
    const before = (await env.req('GET', `/api/projects/${f.pid}/runs`, { cookie: f.viewer.cookie })).body.runs.length;
    const r = await env.req('POST', `/api/projects/${f.pid}/runs/precheck`, { cookie: f.editor.cookie, body: { scriptPath: 'url-secret.yaml' } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, environment: { name: 'dev' }, credentialNames: ['USER_EMAIL'] });
    expect(r.body.problems.map((p: { code: string }) => p.code)).toEqual(['SECRET_PLACEMENT']);
    const ok = await env.req('POST', `/api/projects/${f.pid}/runs/precheck`, { cookie: f.editor.cookie, body: { scriptPath: 'ok.yaml' } });
    expect(ok.body.ok).toBe(true);
    expect((await env.req('GET', `/api/projects/${f.pid}/runs`, { cookie: f.viewer.cookie })).body.runs.length).toBe(before);
  });

  it('validates the request: one target, time limit ≤ 24 h, known script', async () => {
    expect((await requestRun(env, f, { scriptPath: 'ok.yaml', suiteId: 'x' })).status).toBe(422);
    expect((await requestRun(env, f, { scriptPath: 'ok.yaml', timeLimitSec: 24 * 3600 + 1 })).status).toBe(422);
    expect((await requestRun(env, f, { scriptPath: 'nope.yaml' })).status).toBe(404);
    expect((await requestRun(env, f, { scriptPath: 'ok.yaml', timeLimitSec: 3600 })).body.timeLimitSec).toBe(3600);
    await env.req('PATCH', `/api/projects/${f.pid}`, { cookie: f.owner.cookie, body: { runTimeLimitSec: 7200 } });
    expect((await requestRun(env, f, { scriptPath: 'ok.yaml' })).body.timeLimitSec).toBe(7200);
  });

  it('a trashed project is 404', async () => {
    const p = await env.req('POST', '/api/projects', { cookie: f.owner.cookie, body: { name: 'trash-me' } });
    await env.req('DELETE', `/api/projects/${p.body.id}`, { cookie: f.owner.cookie, body: { confirmName: 'trash-me' } });
    const r = await env.req('POST', `/api/projects/${p.body.id}/runs`, { cookie: f.owner.cookie, body: { scriptPath: 'ok.yaml' } });
    expect(r.status).toBe(404);
  });
});

describe('run permissions', () => {
  let env: TestEnv;
  let f: ProjectFixture;
  beforeAll(async () => {
    env = await TestEnv.create();
    f = await projectFixture(env);
    await saveScript(env, f, 'a.yaml', SIMPLE_SCRIPT());
  });
  afterAll(async () => env?.close());

  it('viewers can read but not run or cancel; read tokens cannot run; write tokens run as ai_mcp', async () => {
    const run = await requestRun(env, f, { scriptPath: 'a.yaml' });
    expect(run.status).toBe(201);
    expect((await requestRun(env, f, { scriptPath: 'a.yaml' }, f.viewer.cookie)).status).toBe(403);
    expect((await env.req('POST', `/api/projects/${f.pid}/runs/precheck`, { cookie: f.viewer.cookie, body: { scriptPath: 'a.yaml' } })).status).toBe(403);
    expect((await env.req('POST', `/api/projects/${f.pid}/runs/${run.body.id}/cancel`, { cookie: f.viewer.cookie })).status).toBe(403);
    expect((await env.req('GET', `/api/projects/${f.pid}/runs/${run.body.id}`, { cookie: f.viewer.cookie })).status).toBe(200);
    expect((await env.req('GET', `/api/projects/${f.pid}/runs`, { cookie: f.viewer.cookie })).body.runs).toHaveLength(1);

    const tok = async (permission: string) =>
      (await env.req('POST', '/api/me/tokens', { cookie: f.editor.cookie, body: { name: `t-${permission}`, permission } })).body.token as string;
    const read = await tok('read');
    const rw = await tok('read_write');
    expect((await env.req('POST', `/api/projects/${f.pid}/runs`, { bearer: read, body: { scriptPath: 'a.yaml' } })).status).toBe(403);
    expect((await env.req('POST', `/api/projects/${f.pid}/runs/${run.body.id}/cancel`, { bearer: read })).status).toBe(403);
    expect((await env.req('GET', `/api/projects/${f.pid}/runs/${run.body.id}`, { bearer: read })).status).toBe(200);
    const ai = await env.req('POST', `/api/projects/${f.pid}/runs`, { bearer: rw, body: { scriptPath: 'a.yaml', source: 'web' } });
    expect(ai.status).toBe(201);
    expect(ai.body.source).toBe('ai_mcp');
    expect(ai.body.requestedBy.label).toMatch(/^AI — /);
  });

  it('the internal API is not on the public listener and needs the runner token', async () => {
    expect((await env.req('POST', '/internal/runner/claim', { body: { runnerId: 'x', slots: 1 } })).status).toBe(404);
    expect((await env.ireq('POST', '/internal/runner/claim', { body: { runnerId: 'x', slots: 1 }, token: null })).status).toBe(401);
    expect((await env.ireq('POST', '/internal/runner/claim', { body: { runnerId: 'x', slots: 1 }, token: 'wrong-token' })).status).toBe(401);
    expect((await env.ireq('POST', '/internal/runner/claim', { body: { runnerId: 'x', slots: 1 }, token: f.editor.cookie })).status).toBe(401);
  });
});

describe('run queue', () => {
  let env: TestEnv;
  let f: ProjectFixture;
  const runner = () => new FakeRunner(env);
  beforeAll(async () => {
    env = await TestEnv.create();
    f = await projectFixture(env, { credentials: { ACC_A: 'queue-secret-A-77', ACC_B: 'queue-secret-B-88' } });
    await saveScript(env, f, 'a1.yaml', CRED_SCRIPT('ACC_A', 'A1'));
    await saveScript(env, f, 'a2.yaml', CRED_SCRIPT('ACC_A', 'A2'));
    await saveScript(env, f, 'b.yaml', CRED_SCRIPT('ACC_B', 'B'));
    await saveScript(env, f, 'free.yaml', SIMPLE_SCRIPT('Free'));
  });
  afterAll(async () => env?.close());

  /** Finish everything still active so tests don't block each other. */
  async function drain(r: FakeRunner) {
    for (;;) {
      const c = await r.claim(1);
      if (c.status === 204) break;
      await r.complete(c.body.runId);
    }
  }

  it('same credential runs one at a time; different credentials run in parallel', async () => {
    const r = runner();
    const a1 = (await requestRun(env, f, { scriptPath: 'a1.yaml' })).body.id;
    const a2 = (await requestRun(env, f, { scriptPath: 'a2.yaml' })).body.id;
    const b = (await requestRun(env, f, { scriptPath: 'b.yaml' })).body.id;
    const c1 = await r.claim(4);
    expect(c1.body.runId).toBe(a1);
    expect(c1.body).toMatchObject({ credentialNames: ['ACC_A'], environment: { name: 'dev', allowedDomains: ['dev.example.com'] }, scriptName: 'a1.yaml' });
    expect(c1.body.scriptSource).toContain('ACC_A');
    const c2 = await r.claim(4);
    expect(c2.body.runId).toBe(b); // a2 waits for a1 (same ACC_A)
    expect((await r.claim(4)).status).toBe(204);
    await r.complete(a1);
    expect((await r.claim(4)).body.runId).toBe(a2);
    await r.complete(a2);
    await r.complete(b);
  });

  it('two runners claiming concurrently never get two runs sharing a credential', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await requestRun(env, f, { scriptPath: i % 2 ? 'a1.yaml' : 'a2.yaml' })).body.id);
    const r1 = new FakeRunner(env, 'r1');
    const r2 = new FakeRunner(env, 'r2');
    const got = await Promise.all([r1.claim(1), r2.claim(1), r1.claim(1), r2.claim(1)]);
    expect(got.filter((g) => g.status === 200)).toHaveLength(1);
    const winner = got.find((g) => g.status === 200)!;
    await (got.indexOf(winner) % 2 ? r2 : r1).complete(winner.body.runId);
    await drain(r1);
    await drain(r2);
    const list = (await env.req('GET', `/api/projects/${f.pid}/runs?limit=200`, { cookie: f.viewer.cookie })).body.runs;
    expect(list.filter((x: { id: string; status: string }) => ids.includes(x.id) && x.status === 'passed')).toHaveLength(4);
  });

  it('long-poll claim wakes up when a run is queued', async () => {
    const r = runner();
    const pending = r.claim(1, 10_000);
    await new Promise((res) => setTimeout(res, 300));
    const t0 = Date.now();
    const id = (await requestRun(env, f, { scriptPath: 'free.yaml' })).body.id;
    const c = await pending;
    expect(c.body.runId).toBe(id);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await r.complete(id);
  });

  it('slots 0 gets nothing', async () => {
    const id = (await requestRun(env, f, { scriptPath: 'free.yaml' })).body.id;
    expect((await runner().claim(0)).status).toBe(204);
    await runner().complete((await runner().claim(1)).body.runId);
    expect(id).toBeTruthy();
  });

  it('credentials are handed out once, only to the lease holder', async () => {
    const r = runner();
    const id = (await requestRun(env, f, { scriptPath: 'b.yaml' })).body.id;
    expect((await r.claim(1)).body.runId).toBe(id);
    expect((await new FakeRunner(env, 'other').credentials(id)).status).toBe(409);
    const c = await r.credentials(id);
    expect(c.status).toBe(200);
    expect(c.body.secrets).toEqual({ ACC_B: 'queue-secret-B-88' });
    const again = await r.credentials(id);
    expect(again).toMatchObject({ status: 409, body: { error: { code: 'CREDENTIALS_ALREADY_ISSUED' } } });
    await r.complete(id);
  });

  it('events: leased → running, step index, progress feed, idempotent seq; finish needs the upload', async () => {
    const r = runner();
    const id = (await requestRun(env, f, { scriptPath: 'free.yaml' })).body.id;
    await r.claim(1);
    const ev = [
      { type: 'run.started', seq: 1 },
      { type: 'step.started', seq: 2, stepId: '1', index: 0, action: 'goto' },
      { type: 'step.finished', seq: 3, stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 12 },
      { type: 'metric.recorded', seq: 4, name: 'lcp', value: 120, unit: 'ms', stepId: '1' },
      { type: 'step.started', seq: 5, stepId: '2', index: 1, action: 'click' },
    ];
    const e1 = await r.events(id, ev, '20261020-120000_free_abc123');
    expect(e1.body.stop).toBeNull();
    await r.events(id, ev); // retry of the same batch is ignored
    const d = (await env.req('GET', `/api/projects/${f.pid}/runs/${id}`, { cookie: f.viewer.cookie })).body;
    expect(d).toMatchObject({ status: 'running', currentStep: { stepId: '2', action: 'click' }, runnerLocation: 'test-lab' });
    expect(d.steps).toHaveLength(1);
    expect(d.metrics).toEqual([{ name: 'lcp', value: 120, unit: 'ms', stepId: '1' }]);
    expect((await r.finish(id, { status: 'passed' })).body.error.code).toBe('RESULT_NOT_UPLOADED');
    const feed = await env.ctx.feed.since(f.pid, 0, 1000);
    const kinds = feed.filter((x) => x.data.runId === id).map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(['run.requested', 'run.leased', 'run.started', 'run.progress']));
    await r.complete(id);
    const done = (await env.req('GET', `/api/projects/${f.pid}/runs/${id}`, { cookie: f.viewer.cookie })).body;
    expect(done).toMatchObject({ status: 'passed', resultFiles: 'present', currentStep: null });
    const act = (await env.req('GET', `/api/projects/${f.pid}/activity?kind=run`, { cookie: f.viewer.cookie })).body;
    expect(act.entries.map((i: { kind: string }) => i.kind)).toEqual(expect.arrayContaining(['run.requested', 'run.finished']));
  });

  it('events: the engine `manual` marker of step.finished is stored with the step (reached / not reached / malformed)', async () => {
    const r = runner();
    const id = (await requestRun(env, f, { scriptPath: 'free.yaml' })).body.id;
    await r.claim(1);
    await r.events(id, [
      { type: 'run.started', seq: 1 },
      { type: 'step.finished', seq: 2, stepId: '1', index: 0, action: 'manual', status: 'skipped', durationMs: 0, manual: { instruction: '로고 색이 브랜드 색인지 확인', reason: '사람 판단' } },
      { type: 'step.finished', seq: 3, stepId: '2', index: 1, action: 'expect', status: 'failed', durationMs: 4, error: 'title mismatch' },
      { type: 'step.finished', seq: 4, stepId: '3', index: 2, action: 'manual', status: 'skipped', durationMs: 0, error: 'skipped after step 2 failed', manual: { instruction: '메일 확인', extra: 'dropped' } },
      { type: 'step.finished', seq: 5, stepId: '4', index: 3, action: 'manual', status: 'skipped', durationMs: 0, manual: { instruction: 7 } },
    ]);
    const d = (await env.req('GET', `/api/projects/${f.pid}/runs/${id}`, { cookie: f.viewer.cookie })).body;
    expect(d.steps).toEqual([
      { stepId: '1', index: 0, action: 'manual', status: 'skipped', durationMs: 0, manual: { instruction: '로고 색이 브랜드 색인지 확인', reason: '사람 판단' } },
      { stepId: '2', index: 1, action: 'expect', status: 'failed', durationMs: 4, error: 'title mismatch' },
      { stepId: '3', index: 2, action: 'manual', status: 'skipped', durationMs: 0, error: 'skipped after step 2 failed', manual: { instruction: '메일 확인' } },
      { stepId: '4', index: 3, action: 'manual', status: 'skipped', durationMs: 0 },
    ]);
    await r.complete(id);
  });

  it('cancel: queued → cancelled at once; running → stop signal → cancelled after upload', async () => {
    const r = runner();
    const q = (await requestRun(env, f, { scriptPath: 'a1.yaml' })).body.id;
    const blocked = (await requestRun(env, f, { scriptPath: 'a2.yaml' })).body.id;
    expect((await r.claim(1)).body.runId).toBe(q);
    const c1 = await env.req('POST', `/api/projects/${f.pid}/runs/${blocked}/cancel`, { cookie: f.editor.cookie });
    expect(c1).toMatchObject({ status: 200, body: { status: 'cancelled' } });
    const c2 = await env.req('POST', `/api/projects/${f.pid}/runs/${q}/cancel`, { cookie: f.editor.cookie });
    expect(c2).toMatchObject({ status: 202, body: { status: 'leased', stopRequested: 'cancel' } });
    expect((await r.events(q)).body.stop).toBe('cancel');
    await r.upload(q, await makeTar([{ name: 'steps.jsonl', body: '' }]));
    await r.finish(q, { status: 'cancelled' });
    const d = (await env.req('GET', `/api/projects/${f.pid}/runs/${q}`, { cookie: f.viewer.cookie })).body;
    expect(d.status).toBe('cancelled');
    expect((await env.req('POST', `/api/projects/${f.pid}/runs/${q}/cancel`, { cookie: f.editor.cookie })).status).toBe(409);
  });

  it('runner gone → lease expires → aborted (sweeper, injected clock); late calls get LEASE_LOST', async () => {
    const r = runner();
    const id = (await requestRun(env, f, { scriptPath: 'free.yaml' })).body.id;
    await r.claim(1);
    await r.events(id);
    expect((await sweepRuns(env.ctx)).aborted).toBe(0);
    env.clock.advance(3 * MIN);
    try {
      expect((await sweepRuns(env.ctx)).aborted).toBe(1);
    } finally {
      env.clock.advance(-3 * MIN);
    }
    const d = (await env.req('GET', `/api/projects/${f.pid}/runs/${id}`, { cookie: f.viewer.cookie })).body;
    expect(d.status).toBe('aborted');
    expect(d.error).toMatch(/lease/);
    expect((await r.events(id)).body.error.code).toBe('LEASE_LOST');
  });

  it('time limit → stop request "timeout" → run ends as timeout', async () => {
    const r = runner();
    const id = (await requestRun(env, f, { scriptPath: 'free.yaml', timeLimitSec: 60 })).body.id;
    await r.claim(1);
    expect((await r.events(id)).body.stop).toBeNull();
    env.clock.advance(61_000);
    try {
      expect((await sweepRuns(env.ctx)).timeoutRequested).toBe(1);
      expect((await r.events(id)).body.stop).toBe('timeout');
      await r.upload(id, await makeTar([]));
      await r.finish(id, { status: 'error' });
    } finally {
      env.clock.advance(-61_000);
    }
    const d = (await env.req('GET', `/api/projects/${f.pid}/runs/${id}`, { cookie: f.viewer.cookie })).body;
    expect(d.status).toBe('timeout');
    expect(d.error).toMatch(/time limit/);
  });

  it('upload failure → aborted', async () => {
    const r = runner();
    const id = (await requestRun(env, f, { scriptPath: 'free.yaml' })).body.id;
    await r.claim(1);
    await r.finish(id, { status: 'passed', uploadFailed: true, error: 'ECONNRESET' });
    const d = (await env.req('GET', `/api/projects/${f.pid}/runs/${id}`, { cookie: f.viewer.cookie })).body;
    expect(d).toMatchObject({ status: 'aborted', resultFiles: 'none' });
  });

  it('a queued run whose environment was deleted ends as error at claim', async () => {
    const e = await env.req('POST', `/api/projects/${f.pid}/environments`, { cookie: f.owner.cookie, body: { name: 'gone', baseUrl: 'https://gone.example.com' } });
    const id = (await requestRun(env, f, { scriptPath: 'free.yaml', environmentId: e.body.id })).body.id;
    await env.req('DELETE', `/api/projects/${f.pid}/environments/${e.body.id}`, { cookie: f.owner.cookie });
    expect((await runner().claim(1)).status).toBe(204);
    const d = (await env.req('GET', `/api/projects/${f.pid}/runs/${id}`, { cookie: f.viewer.cookie })).body;
    expect(d).toMatchObject({ status: 'error', environment: { id: null, name: 'gone' } });
  });

  it('suite: children run in order, continue on failure, parent settles', async () => {
    const ids = await Promise.all(['a1.yaml', 'b.yaml', 'free.yaml'].map(async (p) => (await env.req('GET', `/api/projects/${f.pid}/scripts/${p}`, { cookie: f.owner.cookie })).body.id));
    const s = await env.req('POST', `/api/projects/${f.pid}/suites`, { cookie: f.owner.cookie, body: { name: 'Smoke', scriptIds: ids } });
    const run = await requestRun(env, f, { suiteId: s.body.id });
    expect(run.status).toBe(201);
    expect(run.body).toMatchObject({ kind: 'suite', status: 'queued', credentialNames: ['ACC_A', 'ACC_B'] });
    expect(run.body.children.map((c: { script: { path: string } }) => c.script.path)).toEqual(['a1.yaml', 'b.yaml', 'free.yaml']);
    const r = runner();
    const c1 = await r.claim(4);
    expect(c1.body.runId).toBe(run.body.children[0].id);
    expect((await r.claim(4)).status).toBe(204); // b.yaml waits for its earlier sibling
    const fin = await r.complete(c1.body.runId, 'failed');
    expect(fin.body).toEqual({ status: 'failed' });
    const c2 = await r.claim(4);
    expect(c2.body.runId).toBe(run.body.children[1].id);
    await r.complete(c2.body.runId);
    const c3 = await r.claim(4);
    await r.complete(c3.body.runId);
    const d = (await env.req('GET', `/api/projects/${f.pid}/runs/${run.body.id}`, { cookie: f.viewer.cookie })).body;
    expect(d).toMatchObject({ status: 'failed', summary: { total: 3, passed: 2, failed: 1 } });
    expect(d.children.map((c: { status: string }) => c.status)).toEqual(['failed', 'passed', 'passed']);
    // Only top-level runs in the list.
    const list = (await env.req('GET', `/api/projects/${f.pid}/runs?target=${s.body.id}`, { cookie: f.viewer.cookie })).body.runs;
    expect(list.map((x: { id: string }) => x.id)).toEqual([run.body.id]);
  });

  it('suite cancel cancels queued children and stops the running one', async () => {
    const ids = await Promise.all(['free.yaml', 'b.yaml'].map(async (p) => (await env.req('GET', `/api/projects/${f.pid}/scripts/${p}`, { cookie: f.owner.cookie })).body.id));
    const s = await env.req('POST', `/api/projects/${f.pid}/suites`, { cookie: f.owner.cookie, body: { name: 'Cancel me', scriptIds: ids } });
    const run = (await requestRun(env, f, { suiteId: s.body.id })).body;
    const r = runner();
    const c1 = await r.claim(1);
    const c = await env.req('POST', `/api/projects/${f.pid}/runs/${run.id}/cancel`, { cookie: f.editor.cookie });
    expect(c.status).toBe(202);
    expect((await r.events(c1.body.runId)).body.stop).toBe('cancel');
    await r.upload(c1.body.runId, await makeTar([]));
    await r.finish(c1.body.runId, { status: 'cancelled' });
    const d = (await env.req('GET', `/api/projects/${f.pid}/runs/${run.id}`, { cookie: f.viewer.cookie })).body;
    expect(d.status).toBe('cancelled');
    expect(d.children.map((x: { status: string }) => x.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('"항상 실행": the suite keeps the marks (PATCH of other fields keeps the list), a cancel spares marked children', async () => {
    const ids = await Promise.all(['free.yaml', 'a1.yaml', 'b.yaml'].map(async (p) => (await env.req('GET', `/api/projects/${f.pid}/scripts/${p}`, { cookie: f.owner.cookie })).body.id));
    const bad = await env.req('POST', `/api/projects/${f.pid}/suites`, { cookie: f.owner.cookie, body: { name: 'Bad', scriptIds: ids.slice(0, 2), alwaysRun: [ids[2]] } });
    expect(bad.status).toBe(422);
    const s = await env.req('POST', `/api/projects/${f.pid}/suites`, { cookie: f.owner.cookie, body: { name: 'With cleanup', scriptIds: ids, alwaysRun: [ids[2]] } });
    expect(s.status).toBe(201);
    expect(s.body.alwaysRun).toEqual([ids[2]]);
    // Renaming alone keeps the items and marks; dropping an item drops its mark.
    const renamed = await env.req('PATCH', `/api/projects/${f.pid}/suites/${s.body.id}`, { cookie: f.owner.cookie, body: { name: 'With cleanup 2' } });
    expect(renamed.body).toMatchObject({ name: 'With cleanup 2', alwaysRun: [ids[2]] });
    expect(renamed.body.scripts.map((x: { id: string }) => x.id)).toEqual(ids);
    expect((await env.req('PATCH', `/api/projects/${f.pid}/suites/${s.body.id}`, { cookie: f.owner.cookie, body: { scriptIds: ids.slice(0, 2) } })).body.alwaysRun).toEqual([]);
    await env.req('PATCH', `/api/projects/${f.pid}/suites/${s.body.id}`, { cookie: f.owner.cookie, body: { scriptIds: ids, alwaysRun: [ids[2]] } });

    const run = (await requestRun(env, f, { suiteId: s.body.id })).body;
    expect(run.children.map((c: { alwaysRun: boolean }) => c.alwaysRun)).toEqual([false, false, true]);
    const r = runner();
    const c1 = await r.claim(1);
    expect(c1.body.runId).toBe(run.children[0].id);
    expect((await env.req('POST', `/api/projects/${f.pid}/runs/${run.id}/cancel`, { cookie: f.editor.cookie })).status).toBe(202);
    expect((await r.events(c1.body.runId)).body.stop).toBe('cancel');
    await r.upload(c1.body.runId, await makeTar([]));
    await r.finish(c1.body.runId, { status: 'cancelled' });
    // The marked child is still queued and becomes claimable once the earlier ones are terminal.
    let d = (await env.req('GET', `/api/projects/${f.pid}/runs/${run.id}`, { cookie: f.viewer.cookie })).body;
    expect(d.status).toBe('running');
    expect(d.children.map((x: { status: string }) => x.status)).toEqual(['cancelled', 'cancelled', 'queued']);
    const c3 = await r.claim(1);
    expect(c3.body.runId).toBe(run.children[2].id);
    // A second cancel while it runs does not stop it either.
    await env.req('POST', `/api/projects/${f.pid}/runs/${run.id}/cancel`, { cookie: f.editor.cookie });
    expect((await r.events(c3.body.runId)).body.stop).toBeFalsy();
    await r.complete(c3.body.runId, 'passed');
    d = (await env.req('GET', `/api/projects/${f.pid}/runs/${run.id}`, { cookie: f.viewer.cookie })).body;
    expect(d).toMatchObject({ status: 'cancelled', summary: { total: 3, passed: 1, skipped: 2 } });
    expect(d.children.map((x: { status: string }) => x.status)).toEqual(['cancelled', 'cancelled', 'passed']);
  });
});

describe('result files', () => {
  let env: TestEnv;
  let f: ProjectFixture;
  const r = () => new FakeRunner(env);
  beforeAll(async () => {
    env = await TestEnv.create();
    f = await projectFixture(env);
    await saveScript(env, f, 'a.yaml', SIMPLE_SCRIPT());
  });
  afterAll(async () => env?.close());

  async function claimed() {
    const id = (await requestRun(env, f, { scriptPath: 'a.yaml' })).body.id as string;
    expect((await r().claim(1)).body.runId).toBe(id);
    return id;
  }

  it('stores the engine folder, lists, downloads with safe types and serves the report', async () => {
    const id = await claimed();
    const files = [
      { name: 'run.json', body: '{"status":"passed"}' },
      { name: 'report.html', body: '<html><img src="screenshots/001.png"></html>' },
      { name: 'screenshots/', type: 'directory' as const },
      { name: 'screenshots/001.png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: './steps.jsonl', body: '{"type":"run.started"}\n' },
      { name: 'artifacts/evil.html', body: '<script>alert(1)</script>' },
    ];
    await r().complete(id, 'passed', files);
    const base = `/api/projects/${f.pid}/runs/${id}`;
    const list = await env.req('GET', `${base}/files`, { cookie: f.viewer.cookie });
    expect(list.body.resultFiles).toBe('present');
    expect(list.body.files.map((x: { path: string }) => x.path)).toEqual(['artifacts/evil.html', 'report.html', 'run.json', 'screenshots/001.png', 'steps.jsonl']);
    const png = await env.req('GET', `${base}/files/screenshots/001.png`, { cookie: f.viewer.cookie });
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['x-content-type-options']).toBe('nosniff');
    const evil = await env.req('GET', `${base}/files/artifacts/evil.html`, { cookie: f.viewer.cookie });
    expect(evil.headers['content-type']).toBe('application/octet-stream');
    expect(evil.headers['content-disposition']).toMatch(/^attachment/);
    const rep = await env.req('GET', `${base}/report`, { cookie: f.viewer.cookie });
    expect(rep.status).toBe(302);
    expect(rep.headers.location).toBe(`${base}/files/report.html`);
    const html = await env.req('GET', `${base}/files/report.html`, { cookie: f.viewer.cookie });
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(String(html.headers['content-security-policy'])).toContain("default-src 'none'");
    expect(html.text).toContain('screenshots/001.png');
    for (const bad of ['../../../etc/passwd', '..%2F..%2Fetc%2Fpasswd', '%2Fetc%2Fpasswd', 'screenshots%2F..%2Frun.json']) {
      expect((await env.req('GET', `${base}/files/${bad}`, { cookie: f.viewer.cookie })).status).toBe(404);
    }
    expect((await env.req('GET', `${base}/files/run.json`)).status).toBe(401);
  });

  it('rejects tar entries with .., absolute paths, symlinks and hard links; nothing is kept', async () => {
    for (const bad of [
      [{ name: 'ok.txt', body: 'x' }, { name: '../escape.txt', body: 'x' }],
      [{ name: '/etc/cron.d/evil', body: 'x' }],
      [{ name: 'a/../../b.txt', body: 'x' }],
      [{ name: 'link', type: 'symlink' as const, linkname: '/etc/passwd' }],
      [{ name: 'hard', type: 'link' as const, linkname: 'run.json' }],
    ]) {
      const id = await claimed();
      const up = await r().upload(id, await makeTar(bad));
      expect(up.status).toBe(422);
      expect(up.body.error.code).toBe('TAR_REJECTED');
      expect(await env.ctx.results.list(f.pid, id)).toEqual([]);
      await r().finish(id, { status: 'passed', uploadFailed: true });
    }
  });

  it('rejects uploads over the per-run cap', async () => {
    const id = await claimed();
    env.ctx.config.resultMaxRunBytes = 1000;
    try {
      const up = await r().upload(id, await makeTar([{ name: 'big.bin', body: Buffer.alloc(5000) }]));
      expect(up.status).toBe(413);
    } finally {
      env.ctx.config.resultMaxRunBytes = 64 * 1024 * 1024;
    }
    // A partial earlier attempt left on disk is dropped when the upload is given up.
    await env.ctx.results.put(f.pid, id, 'partial.txt', (await import('node:stream')).Readable.from(['x']));
    await r().finish(id, { status: 'passed', uploadFailed: true });
    expect(await env.ctx.results.list(f.pid, id)).toEqual([]);
  });

  it('retention: files older than 30 days and the oldest beyond the total cap expire; DB summary stays', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await claimed();
      await r().complete(id, 'passed', [{ name: 'run.json', body: 'x'.repeat(1000) }]);
      ids.push(id);
      env.clock.advance(1000);
    }
    const before = await purgeResults(env.ctx);
    expect(before.expiredByAge + before.expiredBySize).toBe(0);
    // Size cap: keep only ~2 runs' worth → the oldest of everything goes first.
    const all = (await env.req('GET', `/api/projects/${f.pid}/runs?status=passed&limit=200`, { cookie: f.viewer.cookie })).body.runs.filter((x: { resultFiles: string }) => x.resultFiles === 'present');
    expect(all.length).toBeGreaterThanOrEqual(3);
    env.ctx.config.resultMaxTotalBytes = 2500;
    try {
      const s = await purgeResults(env.ctx);
      expect(s.expiredBySize).toBeGreaterThanOrEqual(1);
      expect((await env.req('GET', `/api/projects/${f.pid}/runs/${ids[2]}`, { cookie: f.viewer.cookie })).body.resultFiles).toBe('present');
    } finally {
      env.ctx.config.resultMaxTotalBytes = 12 * 1024 ** 3;
    }
    env.clock.advance(31 * 24 * 60 * MIN);
    try {
      const s = await purgeResults(env.ctx);
      expect(s.expiredByAge).toBeGreaterThanOrEqual(1);
    } finally {
      env.clock.advance(-31 * 24 * 60 * MIN);
    }
    const d = (await env.req('GET', `/api/projects/${f.pid}/runs/${ids[2]}`, { cookie: f.viewer.cookie })).body;
    expect(d).toMatchObject({ status: 'passed', resultFiles: 'expired', summary: { total: 1, passed: 1 } });
    expect((await env.req('GET', `/api/projects/${f.pid}/runs/${ids[2]}/files`, { cookie: f.viewer.cookie })).body).toEqual({ resultFiles: 'expired', files: [] });
    expect((await env.req('GET', `/api/projects/${f.pid}/runs/${ids[2]}/files/run.json`, { cookie: f.viewer.cookie })).status).toBe(404);
    expect(await env.ctx.results.list(f.pid, ids[2]!)).toEqual([]);
    // The DB index is kept for a year, then the run goes too.
    env.clock.advance(366 * 24 * 60 * MIN);
    try {
      expect((await purgeExpired(env.ctx)).runs).toBeGreaterThanOrEqual(3);
    } finally {
      env.clock.advance(-366 * 24 * 60 * MIN);
    }
    expect((await env.req('GET', `/api/projects/${f.pid}/runs/${ids[2]}`, { cookie: f.viewer.cookie })).status).toBe(404);
  });

  it('baselines: download/upload add-only per (environment, runner location), untouched by retention', async () => {
    const id = await claimed();
    const put = await env.ireq('PUT', `/internal/runs/${id}/baselines`, {
      payload: await makeTar([{ name: 'home.png', body: 'v1' }]),
      headers: { 'content-type': 'application/x-tar', 'x-euta-runner-id': 'fake-runner-1' },
    });
    expect(put.body).toEqual({ added: 1 });
    const again = await env.ireq('PUT', `/internal/runs/${id}/baselines`, {
      payload: await makeTar([{ name: 'home.png', body: 'v2' }, { name: '../x.png', body: 'x' }]),
      headers: { 'content-type': 'application/x-tar', 'x-euta-runner-id': 'fake-runner-1' },
    });
    expect(again.status).toBe(422);
    expect((await env.ctx.results.listBaselines(f.pid, f.envId, 'test-lab')).map((x) => x.path)).toEqual(['home.png']);
    const get = await env.internal.inject({ method: 'GET', url: `/internal/runs/${id}/baselines`, headers: { authorization: 'Bearer test-runner-token-0123456789abcdef', 'x-euta-runner-id': 'fake-runner-1' } });
    expect(get.statusCode).toBe(200);
    expect(get.rawPayload.includes(Buffer.from('home.png'))).toBe(true);
    await r().complete(id);
    env.clock.advance(40 * 24 * 60 * MIN);
    try {
      await purgeResults(env.ctx);
    } finally {
      env.clock.advance(-40 * 24 * 60 * MIN);
    }
    expect((await env.ctx.results.listBaselines(f.pid, f.envId, 'test-lab')).map((x) => x.path)).toEqual(['home.png']);
  });
});
