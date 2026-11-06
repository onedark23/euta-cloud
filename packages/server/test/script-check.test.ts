// Web support endpoints (C4): `POST /api/projects/:id/scripts/check` (validate a text or apply a form
// edit with comments kept — same check as save, nothing stored) and `lastRun` on the project list.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptHash } from '@euta/core';
import { INVALID_SCRIPT, TestEnv, VALID_SCRIPT } from './helpers.js';
import { projectFixture, requestRun, saveScript, type ProjectFixture } from './run-helpers.js';

describe('script check + project list lastRun', () => {
  let env: TestEnv;
  let f: ProjectFixture;
  const check = (body: unknown, cookie = f.viewer.cookie) => env.req('POST', `/api/projects/${f.pid}/scripts/check`, { cookie, body });

  beforeAll(async () => {
    env = await TestEnv.create();
    f = await projectFixture(env, { credentials: { USER_EMAIL: 'check-secret-value-1' } });
  });
  afterAll(async () => env?.close());

  it('a viewer can check a text: parsed script, hash, warnings; nothing is stored', async () => {
    const src = `${VALID_SCRIPT}  - goto: "/x?u=\${secrets.OTHER}"\n  - click: { target: "#css" }\n    input: os\n`;
    const r = await check({ source: src, environmentId: f.envId });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ source: src, contentHash: scriptHash(src), validation: { parsed: true, ok: true, issues: [] }, unstable: 1 });
    expect(r.body.script.name).toBe('Login');
    expect(r.body.script.steps).toHaveLength(6);
    expect(r.body.secretNames).toEqual(['OTHER', 'USER_EMAIL']);
    expect(r.body.missingSecrets).toEqual(['OTHER']);
    expect(r.body.ruleIssues.map((i: { path: string }) => i.path)).toEqual(['steps[4].goto']);
    expect(r.body.osInputIssues.map((i: { path: string }) => i.path)).toEqual(['steps[5].input']);
    const list = await env.req('GET', `/api/projects/${f.pid}/scripts`, { cookie: f.viewer.cookie });
    expect(list.body.scripts).toHaveLength(0);
    // Never echoes credential values (it only knows names).
    expect(r.text).not.toContain('check-secret-value-1');
  });

  it('invalid and non-YAML texts report issues the same way the save does', async () => {
    const bad = await check({ source: INVALID_SCRIPT });
    expect(bad.body.validation).toMatchObject({ parsed: true, ok: false });
    expect(bad.body.validation.issues.length).toBeGreaterThan(0);
    const notYaml = await check({ source: 'a: [unclosed' });
    expect(notYaml.body).toMatchObject({ script: null, validation: { parsed: false, ok: false } });
  });

  it('applies a form edit to the base text keeping comments and untouched formatting', async () => {
    const base = `# 맨 위 주석\n${VALID_SCRIPT}`;
    const parsed = (await check({ source: base })).body.script;
    const steps = parsed.steps.map((s: Record<string, unknown>, i: number) => ({ src: ['steps', i], step: s }));
    steps[0] = { src: ['steps', 0], step: { goto: '/signin' } };
    steps.push({ step: { wait: { ms: 500 } } });
    const r = await check({ base, edit: { header: { version: 1, name: 'Login 2', target: parsed.target }, steps } });
    expect(r.status).toBe(200);
    expect(r.body.source).toContain('# 맨 위 주석');
    expect(r.body.source).toContain('goto: /signin');
    expect(r.body.source).toContain('fill: { target: { label: 이메일 }, value: "${secrets.USER_EMAIL}" }');
    expect(r.body.script).toMatchObject({ name: 'Login 2' });
    expect(r.body.script.steps.at(-1)).toEqual({ wait: { ms: 500 } });
    expect(r.body.validation.ok).toBe(true);
  });

  it('rejects ambiguous bodies, unknown environments and other projects', async () => {
    expect((await check({})).status).toBe(422);
    expect((await check({ source: VALID_SCRIPT, base: VALID_SCRIPT, edit: { header: {}, steps: [] } })).status).toBe(422);
    expect((await check({ source: VALID_SCRIPT, environmentId: 'nope' })).status).toBe(404);
    expect((await env.req('POST', `/api/projects/nope/scripts/check`, { cookie: f.viewer.cookie, body: { source: VALID_SCRIPT } })).status).toBe(404);
    expect((await env.req('POST', `/api/projects/${f.pid}/scripts/check`, { body: { source: VALID_SCRIPT } })).status).toBe(401);
  });

  it('project list carries the latest top-level run', async () => {
    const before = await env.req('GET', '/api/projects?scope=all', { cookie: f.viewer.cookie });
    expect(before.body.projects.find((p: { id: string }) => p.id === f.pid).lastRun).toBeNull();
    await saveScript(env, f, 'ok.yaml', VALID_SCRIPT);
    const first = (await requestRun(env, f, { scriptPath: 'ok.yaml' })).body.id;
    const second = (await requestRun(env, f, { scriptPath: 'ok.yaml' })).body.id;
    expect(first).not.toBe(second);
    const after = await env.req('GET', '/api/projects?scope=all', { cookie: f.viewer.cookie });
    expect(after.body.projects.find((p: { id: string }) => p.id === f.pid).lastRun).toMatchObject({ id: second, status: 'queued', flaky: false, finishedAt: null });
  });
});
