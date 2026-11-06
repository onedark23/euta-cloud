// End to end: real server (Postgres) + real runner loop + real engine CLI (Chromium) against the
// engine's fixture site on 127.0.0.1 (ALLOW_PRIVATE_TARGETS for tests only). SPEC 완료 기준 C1.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USER, startFixtureServer, type FixtureServer } from '../../../../euta-engine/packages/core/test/fixture-site/server.js';
import { sweepRuns } from '../../server/src/services/run-queue.js';
import { dumpDatabase, TEST_RUNNER_TOKEN, TestEnv } from '../../server/test/helpers.js';
import { projectFixture, requestRun, saveScript, type ProjectFixture } from '../../server/test/run-helpers.js';
import { loadRunnerConfig, type RunnerConfig } from '../src/config.js';
import { startRunner, type RunnerHandle } from '../src/runner.js';
import { jsonLogger } from '../src/log.js';

const LOGIN = (expectUrl = '/dashboard', extra = '') => `version: 1
name: Login ${expectUrl}
target:
  baseUrl: \${env.BASE_URL}
defaults: { timeout: 5s }
steps:
  - goto: /login
  - fill: { target: { label: 이메일 }, value: "\${secrets.USER_EMAIL}" }
  - fill: { target: { label: 비밀번호 }, value: "\${secrets.USER_PASSWORD}" }
  - click: { target: { role: button, name: 로그인 } }
  - expect: { url: ${expectUrl} }
${extra}`;

const WAIT = (cred: string | null, ms: string, name: string) => `version: 1
name: ${name}
target:
  baseUrl: \${env.BASE_URL}
record: { video: false, trace: false, har: false }
steps:
  - goto: /login
${cred ? `  - fill: { target: { label: 이메일 }, value: "\${secrets.${cred}}" }\n` : ''}  - wait: { ms: ${ms} }
    timeout: 10m
`;

const secretNeedles = () => {
  const out = new Set<string>();
  for (const v of [FIXTURE_USER.email, FIXTURE_USER.password, 'other-account-secret-xyz']) {
    out.add(v);
    out.add(encodeURIComponent(v));
    out.add(new URLSearchParams({ v }).toString().slice(2));
  }
  return [...out];
};

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

const until = async (what: string, fn: () => Promise<boolean>, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('runner E2E (server + runner + engine + fixture site)', () => {
  let env: TestEnv;
  let site: FixtureServer;
  let f: ProjectFixture;
  let runner: RunnerHandle;
  let cfg: RunnerConfig;
  const runnerLogs: string[] = [];

  const get = async (id: string) => (await env.req('GET', `/api/projects/${f.pid}/runs/${id}`, { cookie: f.viewer.cookie })).body;
  const done = (id: string, ms = 90_000) =>
    until(`run ${id} to end`, async () => !['queued', 'leased', 'running'].includes((await get(id)).status), ms).then(() => get(id));

  beforeAll(async () => {
    site = await startFixtureServer();
    env = await TestEnv.create({ config: { allowPrivateTargets: true, runnerHeartbeatMs: 1000, logLevel: 'info' } });
    const { internalUrl } = await env.listen();
    f = await projectFixture(env, { baseUrl: site.url, credentials: { USER_EMAIL: FIXTURE_USER.email, USER_PASSWORD: FIXTURE_USER.password, OTHER: 'other-account-secret-xyz' } });
    await saveScript(env, f, 'login.yaml', LOGIN());
    await saveScript(env, f, 'login-fail.yaml', LOGIN('/nowhere'));
    await saveScript(env, f, 'wait-a1.yaml', WAIT('USER_EMAIL', '2500ms', 'A1'));
    await saveScript(env, f, 'wait-a2.yaml', WAIT('USER_EMAIL', '2500ms', 'A2'));
    await saveScript(env, f, 'wait-other.yaml', WAIT('OTHER', '2500ms', 'Other'));
    await saveScript(env, f, 'wait-long.yaml', WAIT(null, '120s', 'Long'));
    cfg = {
      ...loadRunnerConfig({ EUTA_SERVER_URL: internalUrl, EUTA_RUNNER_TOKEN: TEST_RUNNER_TOKEN, RUNNER_ID: 'e2e-runner', RUNNER_LOCATION: 'test-lab' }),
      concurrency: 2,
      workDir: mkdtempSync(join(tmpdir(), 'euta-runner-work-')),
      claimWaitMs: 2000,
      killGraceMs: 3000,
      retryBaseMs: 200,
    };
    runner = startRunner(cfg, jsonLogger((l) => void runnerLogs.push(l)));
  });
  afterAll(async () => {
    await runner?.stop();
    await env?.close();
    await site?.close();
  });

  it('a fixture-site login script passes; the result folder matches the engine layout; on-failure recording is dropped', async () => {
    const id = (await requestRun(env, f, { scriptPath: 'login.yaml' })).body.id;
    const d = await done(id);
    expect(d).toMatchObject({ status: 'passed', resultFiles: 'present', runnerLocation: 'test-lab', summary: { total: 5, passed: 5 } });
    expect(d.steps.map((s: { action: string }) => s.action)).toEqual(['goto', 'fill', 'fill', 'click', 'expect']);
    const files = (await env.req('GET', `/api/projects/${f.pid}/runs/${id}/files`, { cookie: f.viewer.cookie })).body.files.map((x: { path: string }) => x.path);
    for (const p of ['run.json', 'steps.jsonl', 'run.log', 'report.html', 'network.har', 'console.jsonl']) expect(files).toContain(p);
    expect(files.some((p: string) => p.startsWith('screenshots/'))).toBe(true);
    expect(files).not.toContain('index.sqlite');
    expect(files).not.toContain('trace.zip');
    expect(files).not.toContain('video/video.webm');
    const runJson = JSON.parse((await env.req('GET', `/api/projects/${f.pid}/runs/${id}/files/run.json`, { cookie: f.viewer.cookie })).text);
    expect(runJson).toMatchObject({ status: 'passed', record: { video: 'on-failure', trace: 'on-failure' } });
    const rep = await env.req('GET', `/api/projects/${f.pid}/runs/${id}/report`, { cookie: f.viewer.cookie });
    const html = await env.req('GET', rep.headers.location as string, { cookie: f.viewer.cookie });
    expect(html.status).toBe(200);
    expect(html.text).toContain('Login /dashboard');
  });

  it('a failing run keeps its on-failure video and trace', async () => {
    const id = (await requestRun(env, f, { scriptPath: 'login-fail.yaml' })).body.id;
    const d = await done(id);
    expect(d.status).toBe('failed');
    const files = (await env.req('GET', `/api/projects/${f.pid}/runs/${id}/files`, { cookie: f.viewer.cookie })).body.files.map((x: { path: string }) => x.path);
    expect(files).toContain('trace.zip');
    expect(files).toContain('video/video.webm');
  });

  it('two runs sharing a credential run one after the other; a different credential runs in parallel', async () => {
    const a1 = (await requestRun(env, f, { scriptPath: 'wait-a1.yaml' })).body.id;
    const a2 = (await requestRun(env, f, { scriptPath: 'wait-a2.yaml' })).body.id;
    const [r1, r2] = [await done(a1), await done(a2)];
    expect([r1.status, r2.status]).toEqual(['passed', 'passed']);
    expect(Date.parse(r2.startedAt)).toBeGreaterThanOrEqual(Date.parse(r1.finishedAt) - 50);

    const b1 = (await requestRun(env, f, { scriptPath: 'wait-a1.yaml' })).body.id;
    const b2 = (await requestRun(env, f, { scriptPath: 'wait-other.yaml' })).body.id;
    const [s1, s2] = [await done(b1), await done(b2)];
    expect([s1.status, s2.status]).toEqual(['passed', 'passed']);
    const overlap = Math.min(Date.parse(s1.finishedAt), Date.parse(s2.finishedAt)) - Math.max(Date.parse(s1.startedAt), Date.parse(s2.startedAt));
    expect(overlap).toBeGreaterThan(1000);
  });

  it('cancel a running run: the engine is killed and partial results are kept', async () => {
    const id = (await requestRun(env, f, { scriptPath: 'wait-long.yaml' })).body.id;
    await until('wait step running', async () => (await get(id)).currentStep?.action === 'wait');
    const c = await env.req('POST', `/api/projects/${f.pid}/runs/${id}/cancel`, { cookie: f.editor.cookie });
    expect(c.status).toBe(202);
    const t0 = Date.now();
    const d = await done(id, 30_000);
    expect(d.status).toBe('cancelled');
    expect(Date.now() - t0).toBeLessThan(15_000);
    const files = (await env.req('GET', `/api/projects/${f.pid}/runs/${id}/files`, { cookie: f.viewer.cookie })).body.files.map((x: { path: string }) => x.path);
    expect(files).toContain('steps.jsonl');
  });

  it('cancel a queued run', async () => {
    // Both slots busy with long runs → the third stays queued.
    const l1 = (await requestRun(env, f, { scriptPath: 'wait-long.yaml' })).body.id;
    const l2 = (await requestRun(env, f, { scriptPath: 'wait-long.yaml' })).body.id;
    const q = (await requestRun(env, f, { scriptPath: 'login.yaml' })).body.id;
    await until('both long runs running', async () => (await get(l1)).status === 'running' && (await get(l2)).status === 'running');
    expect((await get(q)).status).toBe('queued');
    const c = await env.req('POST', `/api/projects/${f.pid}/runs/${q}/cancel`, { cookie: f.editor.cookie });
    expect(c.body.status).toBe('cancelled');
    for (const id of [l1, l2]) await env.req('POST', `/api/projects/${f.pid}/runs/${id}/cancel`, { cookie: f.editor.cookie });
    expect((await done(l1, 30_000)).status).toBe('cancelled');
    expect((await done(l2, 30_000)).status).toBe('cancelled');
  });

  it('time limit exceeded → the runner kills the engine → timeout', async () => {
    const id = (await requestRun(env, f, { scriptPath: 'wait-long.yaml', timeLimitSec: 60 })).body.id;
    await until('wait step running', async () => (await get(id)).currentStep?.action === 'wait');
    env.clock.advance(61_000); // the server sees the limit passed; its next events reply says stop: timeout
    try {
      const d = await done(id, 30_000);
      expect(d.status).toBe('timeout');
      expect(d.error).toMatch(/time limit/);
    } finally {
      env.clock.advance(-61_000);
    }
  });

  it('runner killed mid-run → the lease expires → aborted', async () => {
    const crashCfg: RunnerConfig = { ...cfg, runnerId: 'doomed-runner', workDir: mkdtempSync(join(tmpdir(), 'euta-runner-doomed-')) };
    await runner.stop(); // the main runner leaves the queue to the doomed one
    const doomed = startRunner(crashCfg, jsonLogger((l) => void runnerLogs.push(l)));
    const id = (await requestRun(env, f, { scriptPath: 'wait-long.yaml' })).body.id;
    await until('wait step running', async () => (await get(id)).currentStep?.action === 'wait');
    await doomed.stop({ graceful: false }); // engine SIGKILLed, nothing reported — like a dead pod
    expect((await get(id)).status).toBe('running');
    env.clock.advance(3 * 60_000);
    try {
      expect((await sweepRuns(env.ctx)).aborted).toBe(1);
    } finally {
      env.clock.advance(-3 * 60_000);
    }
    expect(await get(id)).toMatchObject({ status: 'aborted', error: expect.stringMatching(/lease/) });
    runner = startRunner(cfg, jsonLogger((l) => void runnerLogs.push(l)));
  });

  it('credential plaintext appears nowhere: DB dump, server logs, runner logs, result files, API responses', async () => {
    const needles = secretNeedles();
    const dump = await dumpDatabase(env.dbUrl);
    const logs = env.logs.join('\n');
    const rlogs = runnerLogs.join('\n');
    const responses = env.responses.filter((r) => !r.includes('/credentials ')).join('\n');
    expect(env.logs.length).toBeGreaterThan(20);
    expect(runnerLogs.length).toBeGreaterThan(10);
    const files = filesUnder(env.ctx.config.resultsDir);
    expect(files.some((p) => p.endsWith('trace.zip'))).toBe(true);
    const hits: string[] = [];
    for (const n of needles) {
      if (dump.includes(n)) hits.push(`db: ${n}`);
      if (logs.includes(n)) hits.push(`server log: ${n}`);
      if (rlogs.includes(n)) hits.push(`runner log: ${n}`);
      if (responses.includes(n)) hits.push(`api: ${n}`);
    }
    for (const p of files) {
      const data = readFileSync(p);
      const scan = (label: string, buf: Uint8Array) => {
        const b = Buffer.from(buf);
        for (const n of needles) if (b.includes(n)) hits.push(`${label}: ${n}`);
      };
      scan(p, data);
      if (p.endsWith('.zip')) for (const [name, entry] of Object.entries(unzipSync(data))) scan(`${p}!${name}`, entry);
    }
    expect(hits).toEqual([]);
    // Runner temp dirs (scripts, secrets files) are gone.
    expect(readdirSync(cfg.workDir)).toEqual([]);
  });
});
