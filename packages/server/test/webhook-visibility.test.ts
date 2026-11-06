// Teams webhook URL is a secret (SAS `sig`): only callers who may change project settings
// (editor+, read_write token) see it; viewers / read tokens get `teamsWebhookConfigured` only.
// The URL never reaches logs, the activity log or the change feed (SPEC 프로젝트 필드 "알림").
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activity, changeFeed, notifications } from '../src/db/schema.js';
import { enqueueNotification, scrubWebhook, sendPendingNotifications } from '../src/services/notify.js';
import { TestEnv } from './helpers.js';

const SIG = 'SIG-VISIBILITY-0f9e';
const WEBHOOK = `https://contoso.environment.api.powerplatform.com/powerautomate/automations/direct/workflows/w1/triggers/manual/paths/invoke?api-version=1&sig=${SIG}`;
const WEBHOOK2 = WEBHOOK.replace('w1', 'w2');

describe('Teams webhook URL visibility', () => {
  let env: TestEnv;
  let owner: { id: string; cookie: string };
  let editor: { id: string; cookie: string };
  let viewer: { id: string; cookie: string };
  let pid: string;
  const token = async (cookie: string, permission: 'read' | 'read_write') =>
    (await env.req('POST', '/api/me/tokens', { cookie, body: { name: `t-${permission}`, permission } })).body.token as string;

  beforeAll(async () => {
    env = await TestEnv.create();
    owner = await env.user('owner@example.com');
    editor = await env.user('editor@example.com');
    viewer = await env.user('viewer@example.com');
    const p = await env.req('POST', '/api/projects', { cookie: owner.cookie, body: { name: 'Hooks', teamsWebhookUrl: WEBHOOK } });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ teamsWebhookUrl: WEBHOOK, teamsWebhookConfigured: true });
    pid = p.body.id;
    await env.req('PUT', `/api/projects/${pid}/members/${editor.id}`, { cookie: owner.cookie, body: { role: 'editor' } });
  });
  afterAll(async () => env?.close());

  it('viewers get only teamsWebhookConfigured — single project and list', async () => {
    const one = await env.req('GET', `/api/projects/${pid}`, { cookie: viewer.cookie });
    expect(one.status).toBe(200);
    expect(one.body.teamsWebhookConfigured).toBe(true);
    expect(one.body).not.toHaveProperty('teamsWebhookUrl');
    const list = await env.req('GET', '/api/projects', { cookie: viewer.cookie });
    const row = list.body.projects.find((x: { id: string }) => x.id === pid);
    expect(row).toMatchObject({ myRole: 'viewer', teamsWebhookConfigured: true });
    expect(row).not.toHaveProperty('teamsWebhookUrl');
    expect(one.text + list.text).not.toContain(SIG);
  });

  it('editors and owners see the URL; a read token does not, a read_write token does', async () => {
    for (const cookie of [owner.cookie, editor.cookie]) {
      expect((await env.req('GET', `/api/projects/${pid}`, { cookie })).body.teamsWebhookUrl).toBe(WEBHOOK);
      const list = await env.req('GET', '/api/projects?scope=mine', { cookie });
      expect(list.body.projects.find((x: { id: string }) => x.id === pid).teamsWebhookUrl).toBe(WEBHOOK);
    }
    const read = await env.req('GET', `/api/projects/${pid}`, { bearer: await token(editor.cookie, 'read') });
    expect(read.status).toBe(200);
    expect(read.body).not.toHaveProperty('teamsWebhookUrl');
    expect(read.body.teamsWebhookConfigured).toBe(true);
    const rw = await env.req('GET', `/api/projects/${pid}`, { bearer: await token(editor.cookie, 'read_write') });
    expect(rw.body.teamsWebhookUrl).toBe(WEBHOOK);
    // A viewer's read_write token is still bounded by the role.
    const vrw = await env.req('GET', `/api/projects/${pid}`, { bearer: await token(viewer.cookie, 'read_write') });
    expect(vrw.body).not.toHaveProperty('teamsWebhookUrl');
  });

  it('clearing the URL flips teamsWebhookConfigured; PATCH responses follow the same rule', async () => {
    const set = await env.req('PATCH', `/api/projects/${pid}`, { cookie: editor.cookie, body: { teamsWebhookUrl: WEBHOOK2 } });
    expect(set.body).toMatchObject({ teamsWebhookUrl: WEBHOOK2, teamsWebhookConfigured: true });
    const cleared = await env.req('PATCH', `/api/projects/${pid}`, { cookie: editor.cookie, body: { teamsWebhookUrl: null } });
    expect(cleared.body).toMatchObject({ teamsWebhookUrl: null, teamsWebhookConfigured: false });
    expect((await env.req('GET', `/api/projects/${pid}`, { cookie: viewer.cookie })).body.teamsWebhookConfigured).toBe(false);
    await env.req('PATCH', `/api/projects/${pid}`, { cookie: editor.cookie, body: { teamsWebhookUrl: WEBHOOK } });
  });

  it('a delivery error that quotes the URL is stored and logged with the host only', async () => {
    env.webhook.respond = (call) => new Error(`connect ECONNREFUSED while posting to ${call.url}`);
    await enqueueNotification(env.ctx.db, { projectId: pid, runId: null as unknown as string, kind: 'failure', payload: { type: 'message' }, at: env.clock.now() });
    expect(await sendPendingNotifications(env.ctx)).toMatchObject({ retried: 1 });
    const [n] = await env.ctx.db.select().from(notifications).where(eq(notifications.projectId, pid));
    expect(n!.lastError).toContain('contoso.environment.api.powerplatform.com');
    expect(n!.lastError).not.toContain(SIG);
    env.webhook.respond = () => ({ status: 202 });
    expect(scrubWebhook(`bad ${WEBHOOK}`, WEBHOOK)).toBe('bad contoso.environment.api.powerplatform.com');
    expect(scrubWebhook(`x https://other.example/p?a=1&sig=abc y`, WEBHOOK)).toBe('x https://other.example/p?a=1&sig=*** y');
  });

  it('the URL never reaches logs, the activity log, the change feed or the activity API', async () => {
    const acts = await env.ctx.db.select().from(activity).where(eq(activity.projectId, pid));
    expect(acts.some((a) => a.kind === 'project.updated')).toBe(true);
    const feed = await env.ctx.db.select().from(changeFeed).where(eq(changeFeed.projectId, pid));
    expect(feed.length).toBeGreaterThan(0);
    expect(JSON.stringify(acts)).not.toContain(SIG);
    expect(JSON.stringify(feed)).not.toContain(SIG);
    const api = await env.req('GET', `/api/projects/${pid}/activity`, { cookie: viewer.cookie });
    expect(api.status).toBe(200);
    expect(api.text).not.toContain(SIG);
    expect(api.text).not.toContain('powerplatform');
    const logs = env.logs.join('\n');
    expect(logs).not.toContain(SIG);
    expect(logs).toContain('contoso.environment.api.powerplatform.com'); // host only
  });
});
