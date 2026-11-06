// GET /api/me/events (SPEC_클라우드-앱-연동 "앱 알림"): scheduled failure/recovery events for project
// members, the requester's own run ending, live delivery across server instances, resume with
// Last-Event-ID, and resync once the position was purged.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { userEvents } from '../src/db/schema.js';
import { purgeExpired } from '../src/services/purge.js';
import { TestEnv } from './helpers.js';
import { projectFixture, requestRun, saveScript, SIMPLE_SCRIPT, type ProjectFixture } from './run-helpers.js';
import { createSchedule, finishNext, kst, tick } from './schedule-helpers.js';
import { collect } from './sse.js';

describe('app notification events', () => {
  let env: TestEnv;
  let env2: TestEnv;
  let base: string;
  let base2: string;
  let f: ProjectFixture;

  beforeAll(async () => {
    env = await TestEnv.create();
    env.clock.set(kst('2026-11-12T08:00:00'));
    await env.app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(env.app.server.address() as { port: number }).port}`;
    env2 = await TestEnv.create({ dbUrl: env.dbUrl });
    env2.clock.set(kst('2026-11-12T08:00:00'));
    await env2.app.listen({ host: '127.0.0.1', port: 0 });
    base2 = `http://127.0.0.1:${(env2.app.server.address() as { port: number }).port}`;
    f = await projectFixture(env);
    await saveScript(env, f, 'a.yaml', SIMPLE_SCRIPT('A'));
  });
  afterAll(async () => {
    await env2?.app.close();
    await env2?.internal.close();
    await env?.close();
  });

  it('requires sign-in', async () => {
    expect((await env.req('GET', '/api/me/events')).status).toBe(401);
  });

  it('delivers my own run ending live (event written on another server instance)', async () => {
    const live = collect(`${base2}/api/me/events`, { cookie: f.editor.cookie }, (evs) => evs.some((e) => e.event === 'notification'));
    await new Promise((r) => setTimeout(r, 300));
    await requestRun(env, f, { scriptPath: 'a.yaml' });
    const runId = await finishNext(env, 'passed');
    const evs = await live;
    expect(evs[0]!.event).toBe('ready');
    const n = evs.find((e) => e.event === 'notification')!;
    expect(n.data).toMatchObject({ kind: 'run.finished', projectId: f.pid, runId, data: { status: 'passed', target: 'a.yaml', projectName: 'Runs' } });
    expect(n.id).toBe(String(n.data.id));
  });

  it('scheduled failures go to every member (not to org-wide viewers); resume after Last-Event-ID', async () => {
    const ready = await collect(`${base}/api/me/events`, { cookie: f.owner.cookie }, (evs) => evs.some((e) => e.event === 'ready'));
    const from = ready[0]!.id!;
    const sid = (await env.req('GET', `/api/projects/${f.pid}/scripts/a.yaml`, { cookie: f.owner.cookie })).body.id;
    await createSchedule(env, f, { name: 'A', scriptId: sid, cadence: { kind: 'hourly', minute: 0 } });
    env.clock.set(kst('2026-11-12T09:00:05'));
    await tick(env);
    const failed = await finishNext(env, 'failed');
    env.clock.set(kst('2026-11-12T10:00:05'));
    await tick(env);
    const recovered = await finishNext(env, 'passed');

    // Owner was offline: resume from the earlier position (header) and get both, in order.
    const resumed = await collect(`${base}/api/me/events`, { cookie: f.owner.cookie, 'last-event-id': from }, (evs) => evs.filter((e) => e.event === 'notification').length >= 2);
    const got = resumed.filter((e) => e.event === 'notification').map((e) => [e.data.kind, e.data.runId]);
    expect(got).toEqual([
      ['failure', failed],
      ['recovery', recovered],
    ]);
    const failure = resumed.find((e) => e.data?.kind === 'failure')!.data;
    expect(failure.data).toMatchObject({ scheduleName: 'A', status: 'failed', source: 'schedule', url: `http://euta.test/projects/${f.pid}/runs/${failed}` });
    expect(failure.data.failedStep).toBe('2. fill'); // step 2 is not in SIMPLE_SCRIPT → falls back to the action

    // Same through ?lastEventId= on the other instance, for the editor (member) too.
    const editor = await collect(`${base2}/api/me/events?lastEventId=${from}`, { cookie: f.editor.cookie }, (evs) => evs.filter((e) => e.event === 'notification').length >= 2);
    expect(editor.filter((e) => e.event === 'notification').map((e) => e.data.kind)).toEqual(['failure', 'recovery']);
    // The viewer is not a member: nothing stored for them.
    expect(await env.ctx.db.select().from(userEvents).where(eq(userEvents.userId, f.viewer.id))).toHaveLength(0);
  });

  it('resync when the requested position was purged', async () => {
    const [first] = await env.ctx.db.select().from(userEvents).orderBy(userEvents.id).limit(1);
    env.clock.advance(8 * 24 * 3600_000);
    await requestRun(env, f, { scriptPath: 'a.yaml' }, f.owner.cookie);
    await finishNext(env, 'passed');
    const r = await purgeExpired(env.ctx);
    expect(r.userEvents).toBeGreaterThan(0);
    const evs = await collect(`${base}/api/me/events`, { cookie: f.owner.cookie, 'last-event-id': String(first!.id) }, (e) => e.length >= 1);
    expect(evs[0]!.event).toBe('resync');
  });
});
