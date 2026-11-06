// Retry → flaky and notifications (SPEC 실행 상태 · 알림 · 완료 기준 C3): Teams Workflows webhook
// (fake endpoint) on failure-class and recovery, consecutive failures only once per (target, env),
// off-by-default toggles, human-requested runs → app event only, payload without credential values,
// delivery retry/backoff and status recording.
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifications, runs, userEvents } from '../src/db/schema.js';
import { NOTIFY_MAX_ATTEMPTS, sendPendingNotifications } from '../src/services/notify.js';
import { dumpDatabase, TestEnv } from './helpers.js';
import { CRED_SCRIPT, projectFixture, requestRun, saveScript, type ProjectFixture } from './run-helpers.js';
import { createSchedule, finishNext, kst, tick } from './schedule-helpers.js';

const SECRET = 'notify-secret-value-7f3a';
const WEBHOOK = 'https://contoso.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?api-version=1&sig=SIG-MUST-NOT-BE-LOGGED';

describe('retry, flaky and notifications', () => {
  let env: TestEnv;
  let f: ProjectFixture;
  let hour = 9;

  beforeAll(async () => {
    env = await TestEnv.create();
    env.clock.set(kst('2026-11-10T08:00:00'));
    f = await projectFixture(env, { credentials: { USER_EMAIL: SECRET } });
    await env.req('PATCH', `/api/projects/${f.pid}`, { cookie: f.owner.cookie, body: { teamsWebhookUrl: WEBHOOK } });
    await saveScript(env, f, 'login.yaml', CRED_SCRIPT('USER_EMAIL', 'Login'));
    await saveScript(env, f, 'retry.yaml', CRED_SCRIPT('USER_EMAIL', 'Retry'));
  });
  afterAll(async () => env?.close());

  const scriptId = async (path: string) => (await env.req('GET', `/api/projects/${f.pid}/scripts/${path}`, { cookie: f.owner.cookie })).body.id as string;

  /** Fire the hourly :00 schedule(s) at the next hour and finish the run with `status`. */
  async function occurrence(status: 'passed' | 'failed' | 'error' | 'timeout'): Promise<string> {
    hour++;
    env.clock.set(kst(`2026-11-10T${String(hour).padStart(2, '0')}:00:05`));
    const t = await tick(env);
    expect(t.fired).toBe(1);
    return finishNext(env, status);
  }

  async function send() {
    return sendPendingNotifications(env.ctx);
  }
  const kinds = () => env.webhook.calls.map((c) => c.body.attachments[0].content.body[0].text as string);

  let loginSchedule: string;

  it('a failed scheduled run sends one Teams Workflows card with the failing step sentence', async () => {
    loginSchedule = (await createSchedule(env, f, { name: 'Login hourly', scriptId: await scriptId('login.yaml'), cadence: { kind: 'hourly', minute: 0 } })).body.id;
    const runId = await occurrence('failed');
    expect(await send()).toMatchObject({ sent: 1 });
    expect(env.webhook.calls).toHaveLength(1);
    const call = env.webhook.calls[0]!;
    expect(call.url).toBe(WEBHOOK);
    expect(call.body).toMatchObject({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: { type: 'AdaptiveCard', version: '1.4' } }] });
    const card = call.body.attachments[0].content;
    expect(card.body[0].text).toBe('[euta] 실패 — login.yaml');
    const facts = Object.fromEntries(card.body[1].facts.map((x: { title: string; value: string }) => [x.title, x.value]));
    expect(facts).toMatchObject({ 프로젝트: 'Runs', 대상: 'login.yaml', 환경: 'dev', 상태: '실패', 예약: 'Login hourly' });
    expect(facts['실패 단계']).toMatch(/^2\. .*이메일/);
    expect(facts['소요 시간']).toBe('1초');
    expect(card.actions[0]).toEqual({ type: 'Action.OpenUrl', title: '실행 보기', url: `http://euta.test/projects/${f.pid}/runs/${runId}` });
    const [n] = await env.ctx.db.select().from(notifications).where(eq(notifications.runId, runId));
    expect(n).toMatchObject({ kind: 'failure', status: 'sent', attempts: 1, lastStatusCode: 202 });
  });

  it('consecutive failures of the same target/environment notify only once; a pass after them is a recovery', async () => {
    await occurrence('error');
    await occurrence('timeout');
    await send();
    expect(env.webhook.calls).toHaveLength(1);
    await occurrence('passed');
    await send();
    expect(kinds()).toEqual(['[euta] 실패 — login.yaml', '[euta] 회복 — login.yaml']);
  });

  it('passed / skipped / aborted / flaky are off by default and follow the project toggles', async () => {
    await occurrence('passed');
    await send();
    expect(env.webhook.calls).toHaveLength(2);
    const p = await env.req('PATCH', `/api/projects/${f.pid}`, { cookie: f.editor.cookie, body: { notify: { passed: true, skipped: true } } });
    expect(p.body.notify).toEqual({ skipped: true, aborted: false, passed: true, flaky: false });
    await occurrence('passed');
    // Overlap: leave the next occurrence queued, then the one after is skipped.
    hour++;
    env.clock.set(kst(`2026-11-10T${hour}:00:05`));
    await tick(env);
    hour++;
    env.clock.set(kst(`2026-11-10T${hour}:00:05`));
    expect((await tick(env)).skipped.overlap).toBe(1);
    await send();
    expect(kinds().slice(2)).toEqual(['[euta] 통과 — login.yaml', '[euta] 건너뜀 — login.yaml']);
    const skippedCard = env.webhook.calls[3]!.body.attachments[0].content.body[1].facts.find((x: { title: string }) => x.title === '상태');
    expect(skippedCard.value).toBe('건너뜀(겹침)');
    await finishNext(env, 'passed');
    await send();
    await env.req('PATCH', `/api/projects/${f.pid}`, { cookie: f.editor.cookie, body: { notify: { passed: false, skipped: false } } });
    await env.req('PATCH', `/api/projects/${f.pid}/schedules/${loginSchedule}`, { cookie: f.editor.cookie, body: { enabled: false } });
    env.webhook.calls.length = 0;
  });

  it('a human-requested run never goes to Teams — the requester gets an app event', async () => {
    const r = await requestRun(env, f, { scriptPath: 'login.yaml' });
    expect(r.status).toBe(201);
    const runId = await finishNext(env, 'failed');
    await send();
    expect(env.webhook.calls).toHaveLength(0);
    expect(await env.ctx.db.select().from(notifications).where(eq(notifications.runId, runId))).toHaveLength(0);
    const evs = await env.ctx.db.select().from(userEvents).where(eq(userEvents.runId, runId));
    expect(evs.map((e) => [e.userId, e.kind])).toEqual([[f.editor.id, 'run.finished']]);
    expect(evs[0]!.data).toMatchObject({ status: 'failed', target: 'login.yaml', source: 'web' });
  });

  it('retry once: a failed scheduled run is retried; a passing retry is "passed · flaky" linked to the first attempt', async () => {
    const sid = (await createSchedule(env, f, { name: 'Retry hourly', scriptId: await scriptId('retry.yaml'), cadence: { kind: 'hourly', minute: 0 }, retryOnFailure: true })).body.id;
    const first = await occurrence('failed');
    await send();
    expect(env.webhook.calls).toHaveLength(0); // decided by the retry's outcome
    const [retry] = await env.ctx.db.select().from(runs).where(eq(runs.retryOfRunId, first));
    expect(retry).toMatchObject({ status: 'queued', attempt: 2, scheduleId: sid, source: 'schedule' });
    const second = await finishNext(env, 'passed');
    expect(second).toBe(retry!.id);
    const got = await env.req('GET', `/api/projects/${f.pid}/runs/${second}`, { cookie: f.viewer.cookie });
    expect(got.body).toMatchObject({ status: 'passed', flaky: true, attempt: 2, retryOfRunId: first });
    expect((await env.req('GET', `/api/projects/${f.pid}/runs/${first}`, { cookie: f.viewer.cookie })).body).toMatchObject({ status: 'failed', retryRunId: second });
    await send();
    expect(env.webhook.calls).toHaveLength(0); // flaky toggle off

    // Retry fails too → one failure card that says it was the retry.
    await occurrence('failed');
    await finishNext(env, 'error');
    await send();
    expect(kinds()).toEqual(['[euta] 실패 — retry.yaml']);
    const facts = env.webhook.calls[0]!.body.attachments[0].content.body[1].facts;
    expect(facts).toContainEqual({ title: '시도', value: '재실행 (2회차)' });
    expect(facts).toContainEqual({ title: '상태', value: '오류' });
    await env.req('PATCH', `/api/projects/${f.pid}/schedules/${sid}`, { cookie: f.editor.cookie, body: { enabled: false } });
  });

  it('delivery: 5xx and 429 retry with backoff (Retry-After honoured), other 4xx fail at once; status is recorded', async () => {
    const sid = (await createSchedule(env, f, { name: 'Delivery', scriptId: await scriptId('login.yaml'), cadence: { kind: 'hourly', minute: 0 } })).body.id;
    env.webhook.calls.length = 0;
    let replies: ({ status: number; retryAfter?: string } | Error)[] = [{ status: 500 }, new Error('ECONNRESET'), { status: 429, retryAfter: '600' }, { status: 202 }];
    env.webhook.respond = () => replies.shift() ?? { status: 202 };
    const runId = await occurrence('failed');
    const row = async () => (await env.ctx.db.select().from(notifications).where(eq(notifications.runId, runId)))[0]!;
    expect(await send()).toMatchObject({ retried: 1 });
    expect(await row()).toMatchObject({ status: 'pending', attempts: 1, lastStatusCode: 500, lastError: 'HTTP 500' });
    expect(await send()).toMatchObject({ retried: 0, sent: 0 }); // not due yet
    env.clock.advance(31_000);
    expect(await send()).toMatchObject({ retried: 1 });
    expect((await row()).lastError).toMatch(/^network error: ECONNRESET/);
    env.clock.advance(2 * 60_000 + 1000);
    await send();
    const after429 = await row();
    expect(after429).toMatchObject({ attempts: 3, lastStatusCode: 429 });
    expect(after429.nextAttemptAt.getTime() - env.clock.now().getTime()).toBeGreaterThan(590_000); // max(backoff 10 min, Retry-After 600 s)
    env.clock.advance(10 * 60_000 + 1000);
    expect(await send()).toMatchObject({ sent: 1 });
    expect(await row()).toMatchObject({ status: 'sent', attempts: 4, lastStatusCode: 202 });

    // 400 → failed without retry.
    replies = [{ status: 400 }];
    await occurrence('passed'); // recovery
    expect(await send()).toMatchObject({ failed: 1 });
    const [bad] = await env.ctx.db.select().from(notifications).where(and(eq(notifications.projectId, f.pid))).orderBy(desc(notifications.createdAt)).limit(1);
    expect(bad).toMatchObject({ kind: 'recovery', status: 'failed', attempts: 1, lastStatusCode: 400 });
    expect(NOTIFY_MAX_ATTEMPTS).toBe(5);
    env.webhook.respond = () => ({ status: 202 });
    await env.req('PATCH', `/api/projects/${f.pid}/schedules/${sid}`, { cookie: f.editor.cookie, body: { enabled: false } });
  });

  it('never carries credential values (payloads, DB) and never logs the webhook URL', async () => {
    const raw = env.webhook.calls.map((c) => c.raw).join('\n');
    expect(raw).not.toContain(SECRET);
    const dump = await dumpDatabase(env.dbUrl);
    expect(dump).not.toContain(SECRET);
    expect(env.logs.join('\n')).not.toContain('SIG-MUST-NOT-BE-LOGGED');
    expect(env.logs.join('\n')).toContain('contoso.environment.api.powerplatform.com');
  });
});
