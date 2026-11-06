// The project's default device preset reaches the runner (`--device`) unless the script picks its own
// (SPEC 실행 요청 · ADR-024 결과 C3).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers.js';
import { FakeRunner, projectFixture, requestRun, saveScript, SIMPLE_SCRIPT, type ProjectFixture } from './run-helpers.js';

describe('device default', () => {
  let env: TestEnv;
  let f: ProjectFixture;
  beforeAll(async () => {
    env = await TestEnv.create();
    f = await projectFixture(env);
    await env.req('PATCH', `/api/projects/${f.pid}`, { cookie: f.owner.cookie, body: { browser: { engine: 'chromium', device: 'iPhone 13' } } });
    await saveScript(env, f, 'plain.yaml', SIMPLE_SCRIPT('Plain'));
    await saveScript(env, f, 'own.yaml', SIMPLE_SCRIPT('Own').replace('steps:', 'browser:\n  device: Pixel 7\nsteps:'));
  });
  afterAll(async () => env?.close());

  it('passes the project device only when the script has none', async () => {
    const runner = new FakeRunner(env);
    const a = await requestRun(env, f, { scriptPath: 'plain.yaml' });
    expect(a.body.device).toBe('iPhone 13');
    expect((await runner.claim()).body).toMatchObject({ runId: a.body.id, device: 'iPhone 13', browser: 'chromium' });
    const b = await requestRun(env, f, { scriptPath: 'own.yaml' });
    expect(b.status).toBe(201);
    expect(b.body.device).toBeNull();
  });
});
