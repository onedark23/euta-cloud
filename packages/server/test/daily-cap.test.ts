// Per-project daily run cap (PLAN 결정 "실사용 부작용"): script runs per Asia/Seoul day across
// requests, MCP, schedules and retries. Requests over the cap → 422 DAILY_RUN_CAP_REACHED; a scheduled
// occurrence over the cap → skipped(daily-cap); the count restarts at Seoul midnight.
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runs } from '../src/db/schema.js';
import { TestEnv } from './helpers.js';
import { projectFixture, requestRun, saveScript, SIMPLE_SCRIPT, type ProjectFixture } from './run-helpers.js';
import { createSchedule, kst, tick } from './schedule-helpers.js';

describe('daily run cap', () => {
  let env: TestEnv;
  let f: ProjectFixture;

  beforeAll(async () => {
    env = await TestEnv.create();
    env.clock.set(kst('2026-11-14T23:40:00'));
    f = await projectFixture(env);
    await saveScript(env, f, 'a.yaml', SIMPLE_SCRIPT('A'));
    await saveScript(env, f, 'b.yaml', SIMPLE_SCRIPT('B'));
  });
  afterAll(async () => env?.close());

  const usage = async () => (await env.req('GET', `/api/projects/${f.pid}`, { cookie: f.viewer.cookie })).body.dailyRunUsage;

  it('is a project setting (editor+, default 50) with today\'s usage in the project API', async () => {
    expect(await usage()).toEqual({ day: '2026-11-14', used: 0, cap: 50 });
    expect((await env.req('PATCH', `/api/projects/${f.pid}`, { cookie: f.viewer.cookie, body: { dailyRunCap: 3 } })).status).toBe(403);
    expect((await env.req('PATCH', `/api/projects/${f.pid}`, { cookie: f.editor.cookie, body: { dailyRunCap: 0 } })).status).toBe(422);
    const p = await env.req('PATCH', `/api/projects/${f.pid}`, { cookie: f.editor.cookie, body: { dailyRunCap: 3 } });
    expect(p.body).toMatchObject({ dailyRunCap: 3, dailyRunUsage: { used: 0, cap: 3 } });
  });

  it('rejects requests over the cap with 422 and details; a suite counts each script', async () => {
    expect((await requestRun(env, f, { scriptPath: 'a.yaml' })).status).toBe(201);
    const ids = [(await env.req('GET', `/api/projects/${f.pid}/scripts/a.yaml`, { cookie: f.owner.cookie })).body.id, (await env.req('GET', `/api/projects/${f.pid}/scripts/b.yaml`, { cookie: f.owner.cookie })).body.id];
    const suite = (await env.req('POST', `/api/projects/${f.pid}/suites`, { cookie: f.editor.cookie, body: { name: 'S', scriptIds: ids } })).body.id;
    expect((await requestRun(env, f, { suiteId: suite })).status).toBe(201); // 1 + 2 = 3
    expect(await usage()).toMatchObject({ used: 3, cap: 3 });
    const over = await requestRun(env, f, { scriptPath: 'b.yaml' });
    expect(over.status).toBe(422);
    expect(over.body.error).toMatchObject({ code: 'DAILY_RUN_CAP_REACHED', details: { cap: 3, used: 3, day: '2026-11-14' } });
  });

  it('records a scheduled occurrence over the cap as skipped(daily-cap) — not counted itself', async () => {
    const sid = (await env.req('GET', `/api/projects/${f.pid}/scripts/b.yaml`, { cookie: f.owner.cookie })).body.id;
    const s = (await createSchedule(env, f, { name: 'Late', scriptId: sid, cadence: { kind: 'daily', time: '23:50' } })).body;
    env.clock.set(kst('2026-11-14T23:50:05'));
    const r = await tick(env);
    expect(r.skipped['daily-cap']).toBe(1);
    const [row] = await env.ctx.db.select().from(runs).where(and(eq(runs.scheduleId, s.id)));
    expect(row).toMatchObject({ status: 'skipped', skipReason: 'daily-cap' });
    expect(await usage()).toMatchObject({ used: 3 });
  });

  it('restarts the count at Asia/Seoul midnight (15:00 UTC)', async () => {
    env.clock.set(kst('2026-11-14T23:59:50'));
    expect((await requestRun(env, f, { scriptPath: 'b.yaml' })).status).toBe(422);
    env.clock.set(kst('2026-11-15T00:00:10'));
    expect(await usage()).toEqual({ day: '2026-11-15', used: 0, cap: 3 });
    expect((await requestRun(env, f, { scriptPath: 'b.yaml' })).status).toBe(201);
    expect(await usage()).toMatchObject({ used: 1 });
  });
});
