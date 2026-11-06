// Schedules (SPEC 예약 · 완료 기준 C3): cron/preset next-run calculation in Asia/Seoul, minimum
// interval, CRUD permissions, exactly-once registration with two server instances, restart,
// overlap / missed "skipped" records, creator leaving, trash auto-disable, duration warning.
import { cadenceToCron } from '@euta-cloud/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runs } from '../src/db/schema.js';
import { analyzeCron, nextOccurrence } from '../src/services/cron.js';
import { TestEnv } from './helpers.js';
import { projectFixture, saveScript, SIMPLE_SCRIPT, type ProjectFixture } from './run-helpers.js';
import { createSchedule, kst, tick } from './schedule-helpers.js';

const HOUR = 3600_000;

describe('cron and presets (Asia/Seoul)', () => {
  it('converts presets to 5-field cron', () => {
    expect(cadenceToCron({ kind: 'hourly', minute: 15 })).toBe('15 * * * *');
    expect(cadenceToCron({ kind: 'daily', time: '09:05' })).toBe('5 9 * * *');
    expect(cadenceToCron({ kind: 'weekdays', time: '18:30' })).toBe('30 18 * * 1-5');
    expect(cadenceToCron({ kind: 'weekly', dayOfWeek: 0, time: '00:00' })).toBe('0 0 * * 0');
    expect(cadenceToCron({ kind: 'cron', expression: ' */20   8-18 * * 1-5 ' })).toBe('*/20 8-18 * * 1-5');
  });

  it('computes the next run in Seoul time, strictly after the given instant', () => {
    expect(nextOccurrence('0 9 * * *', kst('2026-11-02T08:59:00')).toISOString()).toBe('2026-11-02T00:00:00.000Z');
    expect(nextOccurrence('0 9 * * *', kst('2026-11-02T09:00:00')).toISOString()).toBe('2026-11-03T00:00:00.000Z');
    // Weekdays from Friday evening → Monday 09:00 KST.
    expect(nextOccurrence('0 9 * * 1-5', kst('2026-11-06T19:00:00'))).toEqual(kst('2026-11-09T09:00:00'));
    // Weekly Sunday 00:00; hourly :15.
    expect(nextOccurrence('0 0 * * 0', kst('2026-11-04T12:00:00'))).toEqual(kst('2026-11-08T00:00:00'));
    expect(nextOccurrence('15 * * * *', kst('2026-11-04T12:20:00'))).toEqual(kst('2026-11-04T13:15:00'));
  });

  it('has no DST shifts: daily runs stay exactly 24 h apart across US/EU DST change dates', () => {
    for (const from of ['2026-03-07T12:00:00', '2026-03-28T12:00:00', '2026-10-24T12:00:00', '2026-10-31T12:00:00']) {
      const a = nextOccurrence('30 2 * * *', kst(from));
      const b = nextOccurrence('30 2 * * *', a);
      const c = nextOccurrence('30 2 * * *', b);
      expect(b.getTime() - a.getTime()).toBe(24 * HOUR);
      expect(c.getTime() - b.getTime()).toBe(24 * HOUR);
      expect(a.getUTCHours()).toBe(17); // 02:30 KST = 17:30 UTC the day before
      expect(a.getUTCMinutes()).toBe(30);
    }
  });

  it('enforces the 10-minute minimum interval and plain 5-field syntax', () => {
    expect(analyzeCron('*/10 * * * *').intervalMin).toBe(10);
    expect(analyzeCron('0 9 * * 1-5').intervalMin).toBe(24 * 60);
    expect(analyzeCron('0 9 * * 1').intervalMin).toBe(7 * 24 * 60);
    expect(() => analyzeCron('*/5 * * * *')).toThrow(/at least 10 minutes/);
    expect(() => analyzeCron('0,5 9 * * *')).toThrow(/5-minute gap/);
    // 23:55 → 00:00 on consecutive allowed days (Feb 28 → Mar 1) is caught too.
    expect(() => analyzeCron('0,55 0,23 28,1 * *')).toThrow(/5-minute gap/);
    expect(() => analyzeCron('0 0 * * * *')).toThrow(/exactly 5 fields/);
    expect(() => analyzeCron('H * * * *')).toThrow(/invalid minute field/);
    expect(() => analyzeCron('0 0 31 2 *')).toThrow();
  });
});

describe('schedules API and scheduler', () => {
  let env: TestEnv;
  let f: ProjectFixture;
  let scriptId: string;

  beforeAll(async () => {
    env = await TestEnv.create();
    env.clock.set(kst('2026-11-02T08:50:00'));
    f = await projectFixture(env);
    scriptId = (await saveScript(env, f, 'smoke.yaml', SIMPLE_SCRIPT('Smoke'))).script.id;
  });
  afterAll(async () => env?.close());

  const scheduleRuns = (id: string) => env.ctx.db.select().from(runs).where(and(eq(runs.scheduleId, id), isNull(runs.parentRunId))).orderBy(runs.createdAt);

  it('rejects intervals under 10 minutes and invalid cron with 422', async () => {
    for (const expression of ['*/5 * * * *', '0,5 9 * * *', '0 0 * * * *', 'not a cron']) {
      const r = await createSchedule(env, f, { name: 'Too often', scriptId, cadence: { kind: 'cron', expression } });
      expect(r.status, expression).toBe(422);
      expect(r.body.error.code).toBe('VALIDATION_FAILED');
    }
    const ok = await createSchedule(env, f, { name: 'Every 10', scriptId, cadence: { kind: 'cron', expression: '*/10 * * * *' }, enabled: false });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ cron: '*/10 * * * *', intervalMin: 10, enabled: false, nextRunAt: null, timezone: 'Asia/Seoul' });
  });

  it('editor+ manage schedules; viewers can only read', async () => {
    const denied = await createSchedule(env, f, { name: 'Viewer', scriptId, cadence: { kind: 'daily', time: '09:00' } }, f.viewer.cookie);
    expect(denied.status).toBe(403);
    const r = await createSchedule(env, f, { name: 'Daily', scriptId, cadence: { kind: 'daily', time: '09:00' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ target: { kind: 'script', script: { id: scriptId, path: 'smoke.yaml' } }, environment: { id: f.envId, name: 'dev' }, cron: '0 9 * * *', retryOnFailure: false, enabled: true });
    expect(r.body.nextRunAt).toBe(kst('2026-11-02T09:00:00').toISOString());
    const list = await env.req('GET', `/api/projects/${f.pid}/schedules`, { cookie: f.viewer.cookie });
    expect(list.status).toBe(200);
    expect(list.body.schedules.map((s: { name: string }) => s.name)).toContain('Daily');
    expect((await env.req('PATCH', `/api/projects/${f.pid}/schedules/${r.body.id}`, { cookie: f.viewer.cookie, body: { name: 'x' } })).status).toBe(403);
    const patched = await env.req('PATCH', `/api/projects/${f.pid}/schedules/${r.body.id}`, { cookie: f.editor.cookie, body: { cadence: { kind: 'weekdays', time: '09:30' } } });
    expect(patched.body).toMatchObject({ cron: '30 9 * * 1-5', nextRunAt: kst('2026-11-02T09:30:00').toISOString() });
    expect((await env.req('DELETE', `/api/projects/${f.pid}/schedules/${r.body.id}`, { cookie: f.viewer.cookie })).status).toBe(403);
    expect((await env.req('DELETE', `/api/projects/${f.pid}/schedules/${r.body.id}`, { cookie: f.editor.cookie })).status).toBe(204);
  });

  it('registers an occurrence exactly once with two server instances ticking together, and keeps going after a restart', async () => {
    const s = (await createSchedule(env, f, { name: 'Once', scriptId, cadence: { kind: 'daily', time: '09:00' } })).body;
    // The creator leaves the project: the schedule keeps running as "예약 — <creator>".
    expect((await env.req('DELETE', `/api/projects/${f.pid}/members/${f.editor.id}`, { cookie: f.owner.cookie })).status).toBe(204);

    const env2 = await TestEnv.create({ dbUrl: env.dbUrl });
    try {
      env.clock.set(kst('2026-11-02T09:00:05'));
      env2.clock.set(kst('2026-11-02T09:00:05'));
      const results = await Promise.all([tick(env), tick(env2), tick(env), tick(env2), tick(env), tick(env2)]);
      expect(results.reduce((n, r) => n + r.fired, 0)).toBe(1);
      const fired = await scheduleRuns(s.id);
      expect(fired).toHaveLength(1);
      expect(fired[0]).toMatchObject({ source: 'schedule', status: 'queued', actorType: 'schedule', requestedByLabel: '예약 — editor', requestedBy: f.editor.id, attempt: 1 });
      expect(fired[0]!.scheduledFor).toEqual(kst('2026-11-02T09:00:00'));
      const after = await env.req('GET', `/api/projects/${f.pid}/schedules/${s.id}`, { cookie: f.owner.cookie });
      expect(after.body.nextRunAt).toBe(kst('2026-11-03T09:00:00').toISOString());
      expect(after.body.lastRun).toMatchObject({ id: fired[0]!.id, status: 'queued' });
    } finally {
      await env2.app.close();
      await env2.internal.close();
    }

    // "Restart": a fresh server instance on the same database picks the schedule up.
    const env3 = await TestEnv.create({ dbUrl: env.dbUrl });
    try {
      env3.clock.set(kst('2026-11-03T09:00:10'));
      await env.ctx.db.update(runs).set({ status: 'passed', finishedAt: kst('2026-11-02T09:05:00') }).where(eq(runs.scheduleId, s.id));
      expect((await tick(env3)).fired).toBe(1);
      expect(await scheduleRuns(s.id)).toHaveLength(2);
    } finally {
      await env3.app.close();
      await env3.internal.close();
    }
    await env.req('PUT', `/api/projects/${f.pid}/members/${f.editor.id}`, { cookie: f.owner.cookie, body: { role: 'editor' } });
    await env.req('PATCH', `/api/projects/${f.pid}/schedules/${s.id}`, { cookie: f.editor.cookie, body: { enabled: false } });
  });

  it('records skipped(overlap) while the previous occurrence is still running', async () => {
    env.clock.set(kst('2026-11-04T10:20:00'));
    const s = (await createSchedule(env, f, { name: 'Hourly', scriptId, cadence: { kind: 'hourly', minute: 30 } })).body;
    env.clock.set(kst('2026-11-04T10:30:05'));
    await tick(env);
    env.clock.set(kst('2026-11-04T11:30:05'));
    const r = await tick(env);
    expect(r.skipped.overlap).toBe(1);
    const rows = await scheduleRuns(s.id);
    expect(rows.map((x) => x.status)).toEqual(['queued', 'skipped']);
    expect(rows[1]).toMatchObject({ skipReason: 'overlap', scheduledFor: kst('2026-11-04T11:30:00') });
    const listed = await env.req('GET', `/api/projects/${f.pid}/runs?source=schedule&status=skipped`, { cookie: f.viewer.cookie });
    expect(listed.body.runs.find((x: { id: string }) => x.id === rows[1]!.id)).toMatchObject({ skipReason: 'overlap', scheduleId: s.id });
    await env.req('PATCH', `/api/projects/${f.pid}/schedules/${s.id}`, { cookie: f.editor.cookie, body: { enabled: false } });
  });

  it('missed occurrences leave one skipped(missed) record and never a catch-up burst', async () => {
    env.clock.set(kst('2026-11-05T10:40:00'));
    const s = (await createSchedule(env, f, { name: 'Missed', scriptId, cadence: { kind: 'hourly', minute: 45 } })).body;
    // The server was down from 10:40 to 13:52 (10:45 · 11:45 · 12:45 · 13:45 missed — 13:45 is past the grace).
    env.clock.set(kst('2026-11-05T13:52:00'));
    const r = await tick(env);
    expect(r).toMatchObject({ fired: 0, skipped: { missed: 1 } });
    let rows = await scheduleRuns(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'skipped', skipReason: 'missed', scheduledFor: kst('2026-11-05T10:45:00') });
    expect((await env.req('GET', `/api/projects/${f.pid}/schedules/${s.id}`, { cookie: f.owner.cookie })).body.nextRunAt).toBe(kst('2026-11-05T14:45:00').toISOString());
    // Down again over 14:45, back at 15:47: 14:45 is recorded as missed, 15:45 (2 min late) still runs.
    env.clock.set(kst('2026-11-05T15:47:00'));
    const r2 = await tick(env);
    expect(r2).toMatchObject({ fired: 1, skipped: { missed: 1 } });
    rows = await scheduleRuns(s.id);
    expect(rows.map((x) => [x.status, x.skipReason, x.scheduledFor?.toISOString()])).toEqual([
      ['skipped', 'missed', kst('2026-11-05T10:45:00').toISOString()],
      ['skipped', 'missed', kst('2026-11-05T14:45:00').toISOString()],
      ['queued', null, kst('2026-11-05T15:45:00').toISOString()],
    ]);
    await env.req('PATCH', `/api/projects/${f.pid}/schedules/${s.id}`, { cookie: f.editor.cookie, body: { enabled: false } });
  });

  it('a disabled period is not "missed": re-enabling plans from now', async () => {
    env.clock.set(kst('2026-11-06T08:00:00'));
    const s = (await createSchedule(env, f, { name: 'Pause', scriptId, cadence: { kind: 'hourly', minute: 10 }, enabled: false })).body;
    env.clock.set(kst('2026-11-06T12:30:00'));
    const on = await env.req('PATCH', `/api/projects/${f.pid}/schedules/${s.id}`, { cookie: f.editor.cookie, body: { enabled: true } });
    expect(on.body.nextRunAt).toBe(kst('2026-11-06T13:10:00').toISOString());
    expect((await tick(env)).skipped.missed).toBe(0);
    expect(await scheduleRuns(s.id)).toHaveLength(0);
    await env.req('PATCH', `/api/projects/${f.pid}/schedules/${s.id}`, { cookie: f.editor.cookie, body: { enabled: false } });
  });

  it('warns when the average of the last 3 durations exceeds the interval', async () => {
    const s = (await createSchedule(env, f, { name: 'Slow', scriptId, cadence: { kind: 'cron', expression: '*/10 * * * *' }, enabled: false })).body;
    const at = kst('2026-11-06T09:00:00');
    for (const [i, ms] of [12, 13, 14].entries()) {
      await env.ctx.db.insert(runs).values({
        projectId: f.pid,
        kind: 'script',
        scriptId,
        scriptPath: 'smoke.yaml',
        environmentId: f.envId,
        environmentName: 'dev',
        source: 'schedule',
        requestedByLabel: '예약 — editor',
        actorType: 'schedule',
        timeLimitSec: 3600,
        record: { video: 'on-failure', trace: 'on-failure' },
        status: 'passed',
        scheduleId: s.id,
        durationMs: ms * 60_000,
        createdAt: new Date(at.getTime() + i * 1000),
        finishedAt: new Date(at.getTime() + i * 1000),
      });
    }
    const got = await env.req('GET', `/api/projects/${f.pid}/schedules/${s.id}`, { cookie: f.viewer.cookie });
    expect(got.body.durationWarning).toEqual({ avgDurationMs: 13 * 60_000, intervalMs: 10 * 60_000 });
  });

  it('a schedule whose script was deleted records an error run with the reason', async () => {
    const other = (await saveScript(env, f, 'gone.yaml', SIMPLE_SCRIPT('Gone'))).script.id;
    env.clock.set(kst('2026-11-07T07:00:00'));
    const s = (await createSchedule(env, f, { name: 'Gone', scriptId: other, cadence: { kind: 'daily', time: '07:30' } })).body;
    expect((await env.req('DELETE', `/api/projects/${f.pid}/scripts/gone.yaml`, { cookie: f.editor.cookie })).status).toBeLessThan(300);
    env.clock.set(kst('2026-11-07T07:30:05'));
    await tick(env);
    const rows = await scheduleRuns(s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('error');
    expect(rows[0]!.error).toMatch(/^precheck failed: script not found/);
  });

  it('a schedule whose environment was deleted records an error run — never another environment', async () => {
    const e = await env.req('POST', `/api/projects/${f.pid}/environments`, { cookie: f.owner.cookie, body: { name: 'stage', baseUrl: 'https://stage.example.com' } });
    env.clock.set(kst('2026-11-07T10:00:00'));
    const s = (await createSchedule(env, f, { name: 'Stage', scriptId, environmentId: e.body.id, cadence: { kind: 'daily', time: '10:30' } })).body;
    expect((await env.req('DELETE', `/api/projects/${f.pid}/environments/${e.body.id}`, { cookie: f.owner.cookie })).status).toBe(204);
    expect((await env.req('GET', `/api/projects/${f.pid}/schedules/${s.id}`, { cookie: f.owner.cookie })).body.environment).toEqual({ id: null, name: null });
    env.clock.set(kst('2026-11-07T10:30:05'));
    await tick(env);
    const rows = await scheduleRuns(s.id);
    expect(rows.map((r) => r.status)).toEqual(['error']);
    expect(rows[0]).toMatchObject({ environmentId: null, environmentName: '(삭제된 환경)' });
    expect(rows[0]!.error).toMatch(/environment was deleted/);
  });

  it('moving the project to the trash turns its schedules off; restoring does not turn them back on', async () => {
    env.clock.set(kst('2026-11-08T07:00:00'));
    const s = (await createSchedule(env, f, { name: 'Trash', scriptId, cadence: { kind: 'daily', time: '08:00' } })).body;
    expect((await env.req('DELETE', `/api/projects/${f.pid}`, { cookie: f.owner.cookie, body: { confirmName: 'Runs' } })).status).toBe(204);
    expect((await env.req('POST', `/api/projects/${f.pid}/restore`, { cookie: f.owner.cookie })).status).toBe(200);
    const got = await env.req('GET', `/api/projects/${f.pid}/schedules/${s.id}`, { cookie: f.owner.cookie });
    expect(got.body).toMatchObject({ enabled: false, disabledReason: 'project_trashed', nextRunAt: null });
    env.clock.set(kst('2026-11-08T08:00:05'));
    await tick(env);
    expect(await scheduleRuns(s.id)).toHaveLength(0);
  });
});
