// Remote MCP (SPEC_클라우드-MCP 완료 기준): SDK client over Streamable HTTP against the real server —
// tool list, read tools, save (success · conflict · validation failure), run request · get_run ·
// cancel, result files (image · text · expired), permissions (read token · viewer), 401 cases,
// rate limit, activity attribution and plaintext-credential scans over every tool result.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apikeys, projects, runs } from '../src/db/schema.js';
import { MCP_TOOL_NAMES } from '../src/mcp/tools.js';
import { INVALID_SCRIPT, TestEnv, VALID_SCRIPT } from './helpers.js';
import { issueToken, McpRecorder, rawMcpPost, type McpSession } from './mcp-helpers.js';
import { FakeRunner, projectFixture, saveScript, type ProjectFixture } from './run-helpers.js';

const EMAIL_VALUE = 'needle-user@corp.example';
const PASSWORD_VALUE = 'N33dle-P4ss-zq81';
const WEBHOOK = 'https://contoso.webhook.office.com/workflows/abc?sig=SIGNATURE-SECRET-123';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const SECRET_URL_SCRIPT = `version: 1
name: Leak
target:
  baseUrl: \${env.BASE_URL}
steps:
  - goto: "/?p=\${secrets.USER_PASSWORD}"
`;
const MISSING_CRED_SCRIPT = `version: 1
name: Missing
target:
  baseUrl: \${env.BASE_URL}
steps:
  - goto: /login
  - fill: { target: { label: 이메일 }, value: "\${secrets.NOPE}" }
`;

describe('remote MCP endpoint', () => {
  let env: TestEnv;
  let f: ProjectFixture;
  let url: string;
  const rec = new McpRecorder();
  let owner: McpSession;
  let editor: McpSession;
  let readOnly: McpSession;
  let viewer: McpSession;
  const tokens: Record<string, { id: string; token: string }> = {};

  beforeAll(async () => {
    env = await TestEnv.create();
    ({ publicUrl: url } = await env.listen());
    f = await projectFixture(env, { credentials: { USER_EMAIL: EMAIL_VALUE, USER_PASSWORD: PASSWORD_VALUE } });
    await env.req('PATCH', `/api/projects/${f.pid}`, { cookie: f.owner.cookie, body: { testRules: '로그인은 항상 secrets 로.', teamsWebhookUrl: WEBHOOK } });
    await saveScript(env, f, 'login.yaml', VALID_SCRIPT);
    tokens.owner = await issueToken(env, f.owner.cookie, 'owner-rw', 'read_write');
    tokens.editor = await issueToken(env, f.editor.cookie, 'mcp-editor', 'read_write');
    tokens.read = await issueToken(env, f.editor.cookie, 'editor-read', 'read');
    tokens.viewer = await issueToken(env, f.viewer.cookie, 'viewer-rw', 'read_write');
    owner = await rec.connect(url, tokens.owner.token);
    editor = await rec.connect(url, tokens.editor.token);
    readOnly = await rec.connect(url, tokens.read.token);
    viewer = await rec.connect(url, tokens.viewer.token);
  });
  afterAll(async () => {
    for (const s of [owner, editor, readOnly, viewer]) await s?.close().catch(() => undefined);
    await env?.close();
  });

  it('advertises exactly the SPEC tools (no session_*, no schedule/env/credential/member writes)', async () => {
    const { tools } = await editor.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(tools).toHaveLength(14);
    const ro = new Map(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    for (const w of ['save_script', 'run_script', 'cancel_run']) expect(ro.get(w)).toBe(false);
    for (const r of ['list_projects', 'get_project', 'read_script', 'get_run']) expect(ro.get(r)).toBe(true);
    expect(editor.client.getInstructions()).toContain('read_script before save_script');
    // Stateless Streamable HTTP: no standalone server-to-client stream.
    const get = await fetch(new URL('/mcp', url), { headers: { authorization: `Bearer ${tokens.read!.token}`, accept: 'text/event-stream' } });
    expect(get.status).toBe(405);
  });

  it('401 with WWW-Authenticate: no token, other schemes, unknown / revoked / expired tokens, cookie sessions, deactivated owners', async () => {
    const expect401 = async (headers: Record<string, string>) => {
      const r = await rawMcpPost(url, headers);
      expect(r.status).toBe(401);
      expect(r.headers.get('www-authenticate')).toMatch(/^Bearer/);
    };
    await expect401({});
    await expect401({ authorization: 'Basic Zm9vOmJhcg==' });
    await expect401({ authorization: 'Bearer not-a-euta-token' });
    await expect401({ authorization: `Bearer euta_${'x'.repeat(48)}` });
    await expect401({ cookie: f.owner.cookie });

    const revoked = await issueToken(env, f.owner.cookie, 'revoked', 'read_write');
    expect((await rawMcpPost(url, { authorization: `Bearer ${revoked.token}` })).status).toBe(200);
    expect((await env.req('DELETE', `/api/me/tokens/${revoked.id}`, { cookie: f.owner.cookie })).status).toBe(204);
    await expect401({ authorization: `Bearer ${revoked.token}` });

    const expired = await issueToken(env, f.owner.cookie, 'expired', 'read');
    await env.ctx.db.update(apikeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apikeys.id, expired.id));
    await expect401({ authorization: `Bearer ${expired.token}` });

    const gone = await env.user('gone@example.com');
    const goneToken = await issueToken(env, gone.cookie, 'gone', 'read_write');
    expect((await rawMcpPost(url, { authorization: `Bearer ${goneToken.token}` })).status).toBe(200);
    expect((await env.req('POST', `/api/admin/users/${gone.id}/deactivate`, { cookie: await env.adminCookie() })).status).toBe(200);
    await expect401({ authorization: `Bearer ${goneToken.token}` });

    // The SDK client surfaces the 401 as a connection failure.
    await expect(rec.connect(url, revoked.token)).rejects.toThrow();
  });

  it('read tools: projects, project (test rules · credential names only · no webhook URL), scripts, schema', async () => {
    const list = await readOnly.call('list_projects');
    expect(list.isError).toBe(false);
    expect(list.data).toEqual([expect.objectContaining({ id: f.pid, name: 'Runs', myRole: 'editor', effectiveRole: 'viewer' })]);

    const p = await owner.call('get_project', { projectId: f.pid });
    expect(p.isError).toBe(false);
    expect(p.data).toMatchObject({ id: f.pid, testRules: '로그인은 항상 secrets 로.', teamsWebhookConfigured: true, myRole: 'owner' });
    expect(p.data).not.toHaveProperty('teamsWebhookUrl');
    expect(p.data.environments).toEqual([expect.objectContaining({ name: 'dev', baseUrl: 'https://dev.example.com', isDefault: true, credentialNames: ['USER_EMAIL', 'USER_PASSWORD'] })]);
    expect(p.data.can).toContain('script.edit');
    expect(Array.isArray(p.data.suites)).toBe(true);

    const scripts = await editor.call('list_scripts', { projectId: f.pid });
    expect(scripts.data).toEqual([expect.objectContaining({ path: 'login.yaml', version: 1, validationOk: true, lastRun: null })]);

    const read = await readOnly.call('read_script', { projectId: f.pid, path: 'login.yaml' });
    expect(read.data).toMatchObject({ path: 'login.yaml', version: 1, source: VALID_SCRIPT, validation: { ok: true } });
    expect(read.data.steps).toHaveLength(4);
    expect(read.data.steps[0]).toMatch(/^1\. /);
    expect(read.data.steps.join('\n')).toContain('로그인');

    const schema = await readOnly.call('get_schema');
    expect(schema.data).toHaveProperty('properties.steps');

    const missing = await readOnly.call('read_script', { projectId: f.pid, path: 'nope.yaml' });
    expect(missing.isError).toBe(true);
    expect(missing.data.error).toMatch(/찾을 수 없음/);
    expect((await readOnly.call('get_project', { projectId: 'no-such-project' })).isError).toBe(true);
  });

  it('validate_script: engine validation + cloud precheck, nothing saved', async () => {
    const good = await readOnly.call('validate_script', { projectId: f.pid, source: VALID_SCRIPT });
    expect(good.data).toMatchObject({ valid: true, runnable: true, cloudPrecheck: { ok: true, environment: { name: 'dev' }, credentialNames: ['USER_EMAIL'] } });

    const leak = await readOnly.call('validate_script', { projectId: f.pid, source: SECRET_URL_SCRIPT });
    expect(leak.data.valid).toBe(true);
    expect(leak.data.runnable).toBe(false);
    expect(leak.data.cloudPrecheck.problems.map((p: { code: string }) => p.code)).toContain('SECRET_PLACEMENT');

    const miss = await readOnly.call('validate_script', { projectId: f.pid, source: MISSING_CRED_SCRIPT, environment: 'dev' });
    expect(miss.data.cloudPrecheck.problems).toEqual([expect.objectContaining({ code: 'CREDENTIALS_MISSING', names: ['NOPE'] })]);

    const bad = await readOnly.call('validate_script', { projectId: f.pid, source: INVALID_SCRIPT });
    expect(bad.data.valid).toBe(false);
    expect(bad.data.issues.length).toBeGreaterThan(0);

    const saved = await readOnly.call('validate_script', { projectId: f.pid, path: 'login.yaml' });
    expect(saved.data.valid).toBe(true);
    expect((await readOnly.call('validate_script', { projectId: f.pid, source: VALID_SCRIPT, environment: 'prod' })).data.error).toMatch(/환경을 찾을 수 없음/);
    expect((await env.req('GET', `/api/projects/${f.pid}/scripts`, { cookie: f.owner.cookie })).body.scripts).toHaveLength(1);
  });

  it('save_script: create · update on the base version · conflict returns the current version · validation failure saves nothing', async () => {
    const created = await editor.call('save_script', { projectId: f.pid, path: 'flows/new.yaml', source: VALID_SCRIPT, memo: 'AI 가 만듦' });
    expect(created.isError).toBe(false);
    expect(created.data).toMatchObject({ saved: true, created: true, path: 'flows/new.yaml', version: 1 });

    const edited = VALID_SCRIPT.replace('/dashboard', '/home');
    const updated = await editor.call('save_script', { projectId: f.pid, path: 'flows/new.yaml', source: edited, baseVersion: 1 });
    expect(updated.data).toMatchObject({ saved: true, created: false, version: 2 });

    const stale = await editor.call('save_script', { projectId: f.pid, path: 'flows/new.yaml', source: VALID_SCRIPT.replace('/dashboard', '/x'), baseVersion: 1 });
    expect(stale.isError).toBe(true);
    expect(stale.data).toMatchObject({ code: 'SCRIPT_CONFLICT', current: { version: 2, source: edited, origin: 'ai_mcp' } });
    expect(stale.data.error).toContain('read_script');

    const newWithBase = await editor.call('save_script', { projectId: f.pid, path: 'flows/ghost.yaml', source: VALID_SCRIPT, baseVersion: 3 });
    expect(newWithBase.data).toMatchObject({ code: 'SCRIPT_CONFLICT', current: null });

    const invalid = await editor.call('save_script', { projectId: f.pid, path: 'flows/new.yaml', source: INVALID_SCRIPT, baseVersion: 2 });
    expect(invalid.isError).toBe(true);
    expect(invalid.data.code).toBe('SCRIPT_INVALID');
    expect(invalid.data.issues.length).toBeGreaterThan(0);

    const same = await editor.call('save_script', { projectId: f.pid, path: 'flows/new.yaml', source: edited, baseVersion: 2 });
    expect(same.data).toMatchObject({ saved: false, unchanged: true, version: 2 });

    // History: origin AI(MCP), author = token owner.
    const versions = (await env.req('GET', `/api/projects/${f.pid}/scripts/flows/new.yaml/versions`, { cookie: f.owner.cookie })).body.versions;
    expect(versions).toHaveLength(2);
    for (const v of versions) expect(v).toMatchObject({ origin: 'ai_mcp', author: { id: f.editor.id } });
    expect(versions[1].memo).toBe('AI 가 만듦');

    // Activity: "AI — <owner> (<token name>)".
    const act = (await env.req('GET', `/api/projects/${f.pid}/activity?kind=script`, { cookie: f.owner.cookie })).body.entries;
    const mine = act.filter((e: { details: { path?: string } }) => e.details.path === 'flows/new.yaml');
    expect(mine.map((e: { kind: string }) => e.kind).sort()).toEqual(['script.created', 'script.saved']);
    for (const e of mine) expect(e.actor).toEqual({ type: 'ai', id: f.editor.id, label: 'AI — editor (mcp-editor)' });
  });

  it('a read token and a viewer cannot use write tools ("권한 없음")', async () => {
    const r1 = await readOnly.call('save_script', { projectId: f.pid, path: 'x.yaml', source: VALID_SCRIPT });
    expect(r1).toMatchObject({ isError: true, data: { code: 'FORBIDDEN' } });
    expect(r1.data.error).toContain('읽기 전용 토큰');
    expect((await readOnly.call('run_script', { projectId: f.pid, scriptPath: 'login.yaml' })).data.code).toBe('FORBIDDEN');

    const r2 = await viewer.call('save_script', { projectId: f.pid, path: 'x.yaml', source: VALID_SCRIPT });
    expect(r2).toMatchObject({ isError: true, data: { code: 'FORBIDDEN' } });
    expect(r2.data.error).toContain('보기 역할');
    expect((await viewer.call('run_script', { projectId: f.pid, scriptPath: 'login.yaml' })).data.code).toBe('FORBIDDEN');
    // Reading is fine for both.
    expect((await viewer.call('read_script', { projectId: f.pid, path: 'login.yaml' })).isError).toBe(false);
    expect((await env.req('GET', `/api/projects/${f.pid}/scripts/x.yaml`, { cookie: f.owner.cookie })).status).toBe(404);
  });

  it('run_script queues and returns the id; get_run · list_runs · cancel_run; precheck problems are tool errors', async () => {
    const r = await editor.call('run_script', { projectId: f.pid, scriptPath: 'login.yaml', environment: 'dev', vars: { lang: 'ko' } });
    expect(r.isError).toBe(false);
    expect(r.data).toMatchObject({ status: 'queued', target: { script: 'login.yaml', version: 1 }, environment: 'dev' });
    const runId = r.data.runId as string;

    const g = await readOnly.call('get_run', { runId });
    expect(g.data).toMatchObject({ id: runId, status: 'queued', source: 'ai_mcp', requestedBy: 'AI — editor (mcp-editor)', vars: { lang: 'ko' }, credentialNames: ['USER_EMAIL'], resultFiles: 'none', files: [] });

    const l = await readOnly.call('list_runs', { projectId: f.pid, source: 'ai_mcp' });
    expect(l.data.map((x: { id: string }) => x.id)).toContain(runId);
    expect((await readOnly.call('list_scripts', { projectId: f.pid })).data.find((s: { path: string }) => s.path === 'login.yaml').lastRun).toMatchObject({ id: runId, status: 'queued' });

    expect((await readOnly.call('cancel_run', { runId })).data.code).toBe('FORBIDDEN');
    const c = await editor.call('cancel_run', { runId });
    expect(c.data).toMatchObject({ runId, status: 'cancelled' });
    expect((await editor.call('cancel_run', { runId })).data.error).toMatch(/이미 끝난 실행/);

    await saveScript(env, f, 'leak.yaml', SECRET_URL_SCRIPT);
    const blocked = await editor.call('run_script', { projectId: f.pid, scriptPath: 'leak.yaml' });
    expect(blocked.isError).toBe(true);
    expect(blocked.data.problems.map((p: { code: string }) => p.code)).toEqual(['SECRET_PLACEMENT']);
    expect(blocked.data.error).toMatch(/실행 전 검사/);

    const act = (await env.req('GET', `/api/projects/${f.pid}/activity?kind=run`, { cookie: f.owner.cookie })).body.entries;
    const requested = act.find((e: { kind: string; target: { id: string } }) => e.kind === 'run.requested' && e.target.id === runId);
    expect(requested.actor).toEqual({ type: 'ai', id: f.editor.id, label: 'AI — editor (mcp-editor)' });
    const cancelled = act.find((e: { kind: string; target: { id: string } }) => e.kind === 'run.cancelled' && e.target.id === runId);
    expect(cancelled.actor.label).toBe('AI — editor (mcp-editor)');

    // Daily cap → a friendly tool error.
    await env.ctx.db.update(projects).set({ dailyRunCap: 1 }).where(eq(projects.id, f.pid));
    const capped = await editor.call('run_script', { projectId: f.pid, scriptPath: 'login.yaml' });
    expect(capped).toMatchObject({ isError: true, data: { code: 'DAILY_RUN_CAP_REACHED', cap: { cap: 1 } } });
    expect(capped.data.error).toContain('실행 상한');
    await env.ctx.db.update(projects).set({ dailyRunCap: 100 }).where(eq(projects.id, f.pid));
  });

  it('result files: step screenshot as an image, text artifacts as text, "파일 만료" once expired', async () => {
    const runId = (await editor.call('run_script', { projectId: f.pid, scriptPath: 'login.yaml' })).data.runId as string;
    const runner = new FakeRunner(env);
    const claim = await runner.claim();
    expect(claim.body.runId).toBe(runId);
    const runJson = JSON.stringify({ status: 'passed', steps: [{ stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 5, screenshot: 'screenshots/1-goto.png' }] });
    await runner.complete(runId, 'passed', [
      { name: 'run.json', body: runJson },
      { name: 'run.log', body: 'line one\nline two\n' },
      { name: 'screenshots/1-goto.png', body: PNG },
    ]);

    const g = await readOnly.call('get_run', { runId });
    expect(g.data).toMatchObject({ status: 'passed', resultFiles: 'present' });
    expect(g.data.files).toEqual(expect.arrayContaining(['run.json', 'run.log', 'screenshots/1-goto.png']));

    const shot = await readOnly.call('get_screenshot', { runId, stepId: '1' });
    expect(shot.isError).toBe(false);
    expect(shot.content[1]).toEqual({ type: 'image', mimeType: 'image/png', data: PNG.toString('base64') });
    expect((await readOnly.call('get_screenshot', { runId, file: 'screenshots/1-goto.png' })).content[1]!.type).toBe('image');
    expect((await readOnly.call('get_screenshot', { runId, stepId: '9' })).isError).toBe(true);
    expect((await readOnly.call('get_screenshot', { runId, file: '../../etc/passwd.png' })).isError).toBe(true);

    const log = await readOnly.call('get_artifact', { runId, file: 'run.log' });
    expect(log.data).toMatchObject({ file: 'run.log', kind: 'text', truncated: false });
    expect(log.content[1]!.text).toContain('line two');
    expect((await readOnly.call('get_artifact', { runId, file: 'run.log', maxChars: 4 })).data).toMatchObject({ truncated: true, returnedChars: 4 });
    expect((await readOnly.call('get_artifact', { runId, file: 'screenshots/1-goto.png' })).data.note).toContain('get_screenshot');

    await env.ctx.db.update(runs).set({ resultFiles: 'expired' }).where(eq(runs.id, runId));
    const expired = await readOnly.call('get_artifact', { runId, file: 'run.log' });
    expect(expired).toMatchObject({ isError: true, data: { code: 'FILES_EXPIRED' } });
    expect(expired.data.error).toContain('파일 만료');
    expect((await readOnly.call('get_screenshot', { runId, stepId: '1' })).data.error).toContain('파일 만료');
  });

  it('list_schedules reads schedules (no write tool exists)', async () => {
    const scriptId = (await env.req('GET', `/api/projects/${f.pid}/scripts/login.yaml`, { cookie: f.owner.cookie })).body.id;
    const s = await env.req('POST', `/api/projects/${f.pid}/schedules`, { cookie: f.owner.cookie, body: { name: 'Nightly', scriptId, cadence: { kind: 'daily', time: '03:00' } } });
    expect(s.status).toBe(201);
    const l = await readOnly.call('list_schedules', { projectId: f.pid });
    expect(l.data).toEqual([expect.objectContaining({ name: 'Nightly', enabled: true, target: { kind: 'script', script: { id: scriptId, path: 'login.yaml', name: 'Login' } } })]);
    expect(l.data[0].nextRunAt).toBeTruthy();
  });

  it('rate limit: 120 calls per token per minute → HTTP 429', async () => {
    const t = await issueToken(env, f.owner.cookie, 'burst', 'read');
    const statuses: number[] = [];
    for (let i = 0; i < 125; i++) statuses.push((await rawMcpPost(url, { authorization: `Bearer ${t.token}` })).status);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(120)).toEqual([429, 429, 429, 429, 429]);
    const r = await rawMcpPost(url, { authorization: `Bearer ${t.token}` });
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('60');
    // Other tokens are unaffected.
    expect((await readOnly.call('list_projects')).isError).toBe(false);
  });

  it('credential values appear in no tool result and no log line', async () => {
    const all = rec.results.join('\n');
    expect(rec.results.length).toBeGreaterThan(40);
    expect(all).toContain('USER_PASSWORD'); // names are fine…
    for (const needle of [EMAIL_VALUE, PASSWORD_VALUE, encodeURIComponent(EMAIL_VALUE), 'SIGNATURE-SECRET-123', ...Object.values(tokens).map((t) => t.token)]) {
      expect(all).not.toContain(needle); // …values never
      expect(env.logs.join('\n')).not.toContain(needle);
    }
  });
});
