// Scheduled suite end to end (SPEC 예약 · 실행 상태 · 알림, 완료 기준 C3): the schedule fires a suite,
// a child fails → the suite fails → "retry once" re-runs the whole suite → the retry passes →
// "passed · flaky"; and the notification decision for each case (flaky toggle off / on, retry fails too).
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifications, runs, userEvents } from '../src/db/schema.js';
import { sendPendingNotifications } from '../src/services/notify.js';
import { TestEnv } from './helpers.js';
import { CRED_SCRIPT, projectFixture, saveScript, type ProjectFixture } from './run-helpers.js';
import { createSchedule, finishNext, kst, tick } from './schedule-helpers.js';

const WEBHOOK = 'https://contoso.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/s/triggers/manual/paths/invoke?api-version=1&sig=SUITE-SIG';
type Outcome = 'passed' | 'failed' | 'error';

describe('scheduled suite: child fails → suite retry → flaky', () => {
  let env: TestEnv;
  let f: ProjectFixture;
  let suiteId: string;
  let hour = 9;

  beforeAll(async () => {
    env = await TestEnv.create();
    env.clock.set(kst('2026-11-12T08:00:00'));
    f = await projectFixture(env, { credentials: { USER_EMAIL: 'suite-secret-value' } });
    await env.req('PATCH', `/api/projects/${f.pid}`, { cookie: f.owner.cookie, body: { teamsWebhookUrl: WEBHOOK } });
    await saveScript(env, f, 'a.yaml', CRED_SCRIPT('USER_EMAIL', 'A'));
    await saveScript(env, f, 'b.yaml', CRED_SCRIPT('USER_EMAIL', 'B'));
    const ids = await Promise.all(['a.yaml', 'b.yaml'].map(async (p) => (await env.req('GET', `/api/projects/${f.pid}/scripts/${p}`, { cookie: f.owner.cookie })).body.id));
    const s = await env.req('POST', `/api/projects/${f.pid}/suites`, { cookie: f.owner.cookie, body: { name: 'Smoke', scriptIds: ids } });
    expect(s.status).toBe(201);
    suiteId = s.body.id;
    const sched = await createSchedule(env, f, { name: 'Smoke hourly', suiteId, cadence: { kind: 'hourly', minute: 0 }, retryOnFailure: true });
    expect(sched.status).toBe(201);
  });
  afterAll(async () => env?.close());

  /** Fire the next hourly occurrence → the scheduled suite's parent run id. */
  async function fire(): Promise<string> {
    hour++;
    env.clock.set(kst(`2026-11-12T${String(hour).padStart(2, '0')}:00:05`));
    expect((await tick(env)).fired).toBe(1);
    const [top] = await env.ctx.db.select().from(runs).where(eq(runs.status, 'queued')).then((rows) => rows.filter((r) => r.kind === 'suite' && r.attempt === 1));
    return top!.id;
  }

  /** Drive the suite's children in order (each claim returns the next eligible child only). */
  async function finishChildren(parentId: string, outcomes: Outcome[]) {
    for (const o of outcomes) {
      const runId = await finishNext(env, o);
      const [child] = await env.ctx.db.select().from(runs).where(eq(runs.id, runId));
      expect(child!.parentRunId).toBe(parentId);
    }
  }

  const retryOf = async (id: string) => (await env.ctx.db.select().from(runs).where(eq(runs.retryOfRunId, id)))[0];
  const detail = async (id: string) => (await env.req('GET', `/api/projects/${f.pid}/runs/${id}`, { cookie: f.viewer.cookie })).body;
  const cards = () => env.webhook.calls.map((c) => c.body.attachments[0].content);
  const notificationsFor = (runId: string) => env.ctx.db.select().from(notifications).where(eq(notifications.runId, runId));
  const eventsFor = (runId: string) => env.ctx.db.select().from(userEvents).where(eq(userEvents.runId, runId));

  it('a failing child fails the suite, which is retried as a whole; nothing is notified for the first attempt', async () => {
    const first = await fire();
    await finishChildren(first, ['failed', 'passed']);
    const d1 = await detail(first);
    expect(d1).toMatchObject({ kind: 'suite', status: 'failed', attempt: 1, source: 'schedule', summary: { total: 2, passed: 1, failed: 1 } });
    expect(d1.children.map((c: { status: string }) => c.status)).toEqual(['failed', 'passed']);

    const retry = await retryOf(first);
    expect(retry).toMatchObject({ kind: 'suite', status: 'queued', attempt: 2, suiteId, source: 'schedule' });
    const retryKids = await env.ctx.db.select().from(runs).where(eq(runs.parentRunId, retry!.id));
    expect(retryKids.map((k) => [k.scriptPath, k.status, k.attempt]).sort()).toEqual([
      ['a.yaml', 'queued', 2],
      ['b.yaml', 'queued', 2],
    ]);
    // The retry's outcome decides: no Teams row, no app event for the first attempt.
    await sendPendingNotifications(env.ctx);
    expect(await notificationsFor(first)).toHaveLength(0);
    expect(await eventsFor(first)).toHaveLength(0);
    expect(env.webhook.calls).toHaveLength(0);

    // The retry passes → "passed · flaky", linked both ways. Flaky notifications are off by default.
    await finishChildren(retry!.id, ['passed', 'passed']);
    const d2 = await detail(retry!.id);
    expect(d2).toMatchObject({ kind: 'suite', status: 'passed', flaky: true, attempt: 2, retryOfRunId: first, summary: { total: 2, passed: 2 } });
    expect((await detail(first)).retryRunId).toBe(retry!.id);
    await sendPendingNotifications(env.ctx);
    expect(await notificationsFor(retry!.id)).toHaveLength(0);
    expect(await eventsFor(retry!.id)).toHaveLength(0);
    expect(env.webhook.calls).toHaveLength(0);
  });

  it('with the flaky toggle on, a flaky suite sends one "통과 · 불안정" card (not a recovery) and app events to members', async () => {
    await env.req('PATCH', `/api/projects/${f.pid}`, { cookie: f.editor.cookie, body: { notify: { flaky: true } } });
    const first = await fire();
    await finishChildren(first, ['passed', 'error']);
    const retry = (await retryOf(first))!;
    await finishChildren(retry.id, ['passed', 'passed']);
    await sendPendingNotifications(env.ctx);
    expect(cards()).toHaveLength(1);
    const card = cards()[0]!;
    expect(card.body[0].text).toBe('[euta] 통과 · 불안정 — 테스트 세트 Smoke');
    const facts = Object.fromEntries(card.body[1].facts.map((x: { title: string; value: string }) => [x.title, x.value]));
    expect(facts).toMatchObject({ 상태: '통과 · 불안정', 예약: 'Smoke hourly', 시도: '재실행 (2회차)', 대상: '테스트 세트 Smoke' });
    expect(card.actions[0].url).toBe(`http://euta.test/projects/${f.pid}/runs/${retry.id}`);
    expect((await notificationsFor(retry.id)).map((n) => n.kind)).toEqual(['flaky']);
    const evs = await eventsFor(retry.id);
    expect(evs.map((e) => [e.userId, e.kind]).sort()).toEqual([
      [f.editor.id, 'flaky'],
      [f.owner.id, 'flaky'],
    ].sort());
    expect(await notificationsFor(first)).toHaveLength(0);
  });

  it('when the retry fails too, one failure card names the failing child and step', async () => {
    env.webhook.calls.length = 0;
    const first = await fire();
    await finishChildren(first, ['passed', 'failed']);
    const retry = (await retryOf(first))!;
    await finishChildren(retry.id, ['passed', 'failed']);
    expect(await detail(retry.id)).toMatchObject({ status: 'failed', flaky: false, attempt: 2 });
    await sendPendingNotifications(env.ctx);
    expect(cards()).toHaveLength(1);
    const card = cards()[0]!;
    expect(card.body[0].text).toBe('[euta] 실패 — 테스트 세트 Smoke');
    const facts = Object.fromEntries(card.body[1].facts.map((x: { title: string; value: string }) => [x.title, x.value]));
    expect(facts['실패 단계']).toMatch(/^b\.yaml — 2\. .*이메일/);
    expect(facts.시도).toBe('재실행 (2회차)');
    expect(env.webhook.calls.map((c) => c.raw).join('\n')).not.toContain('suite-secret-value');
  });
});
