// The role table enforced over HTTP: for every principal kind (4 roles × session / read / read_write
// token, plus an invited viewer) × every action, the API allows exactly what shared `decide()` allows.
// Tokens: min(permission, role). Stage 15 adds the runner role and the owner-only membership actions.
import { scriptHash } from '@euta/core';
import { decide, type ProjectAction, type ProjectRole, type TokenPermission } from '@euta-cloud/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestEnv, VALID_SCRIPT } from './helpers.js';
import { makeTar, SIMPLE_SCRIPT } from './run-helpers.js';

interface Who {
  label: string;
  role: ProjectRole;
  tokenPermission?: TokenPermission;
  auth: { cookie?: string; bearer?: string };
}

describe('role table over HTTP', () => {
  let env: TestEnv;
  let owner: { id: string; cookie: string };
  let coOwner: { id: string; cookie: string };
  let editor: { id: string; cookie: string };
  let runner: { id: string; cookie: string };
  let viewer: { id: string; cookie: string };
  let invitedViewer: { id: string; cookie: string };
  let bystander: { id: string; cookie: string };
  const principals: Who[] = [];
  let n = 0;

  beforeAll(async () => {
    env = await TestEnv.create();
    owner = await env.user('owner@example.com');
    coOwner = await env.user('coowner@example.com');
    editor = await env.user('editor@example.com');
    runner = await env.user('runner@example.com');
    viewer = await env.user('viewer@example.com');
    invitedViewer = await env.user('invited@example.com');
    bystander = await env.user('bystander@example.com');
    const token = async (u: { cookie: string }, permission: TokenPermission) =>
      (await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: `t-${permission}`, permission } })).body.token as string;
    principals.push(
      { label: 'owner (session)', role: 'owner', auth: { cookie: owner.cookie } },
      { label: 'editor (session)', role: 'editor', auth: { cookie: editor.cookie } },
      { label: 'runner (session)', role: 'runner', auth: { cookie: runner.cookie } },
      { label: 'viewer (session, non-member)', role: 'viewer', auth: { cookie: viewer.cookie } },
      { label: 'viewer (session, invited)', role: 'viewer', auth: { cookie: invitedViewer.cookie } },
      { label: 'owner read token', role: 'owner', tokenPermission: 'read', auth: { bearer: await token(owner, 'read') } },
      { label: 'owner read_write token', role: 'owner', tokenPermission: 'read_write', auth: { bearer: await token(owner, 'read_write') } },
      { label: 'editor read token', role: 'editor', tokenPermission: 'read', auth: { bearer: await token(editor, 'read') } },
      { label: 'editor read_write token', role: 'editor', tokenPermission: 'read_write', auth: { bearer: await token(editor, 'read_write') } },
      { label: 'runner read token', role: 'runner', tokenPermission: 'read', auth: { bearer: await token(runner, 'read') } },
      { label: 'runner read_write token', role: 'runner', tokenPermission: 'read_write', auth: { bearer: await token(runner, 'read_write') } },
      { label: 'viewer read_write token', role: 'viewer', tokenPermission: 'read_write', auth: { bearer: await token(viewer, 'read_write') } },
    );
  });
  afterAll(async () => env?.close());

  /**
   * A fresh app-born project owned by `owner` (+ co-owner), editor / runner / invited viewer members,
   * a default environment, a script with credentials and a plain one, and one queued run.
   */
  async function fixture(trashed = false) {
    const localId = `local-${++n}`;
    const p = await env.req('POST', '/api/projects', { cookie: owner.cookie, body: { name: `p${n}`, origin: 'app', originLocalId: localId } });
    const id = p.body.id as string;
    for (const [u, role] of [[coOwner, 'owner'], [editor, 'editor'], [runner, 'runner'], [invitedViewer, 'viewer']] as const) {
      await env.req('PUT', `/api/projects/${id}/members/${u.id}`, { cookie: owner.cookie, body: { role } });
    }
    const e = await env.req('POST', `/api/projects/${id}/environments`, { cookie: owner.cookie, body: { name: 'dev', baseUrl: 'https://dev.example.com', makeDefault: true } });
    await env.req('PUT', `/api/projects/${id}/scripts/login.yaml`, { cookie: owner.cookie, body: { source: VALID_SCRIPT } });
    const simple = await env.req('PUT', `/api/projects/${id}/scripts/simple.yaml`, { cookie: owner.cookie, body: { source: SIMPLE_SCRIPT() } });
    const run = await env.req('POST', `/api/projects/${id}/runs`, { cookie: owner.cookie, body: { scriptPath: 'simple.yaml' } });
    if (run.status !== 201) throw new Error(`run create failed ${run.text}`);
    if (trashed) await env.req('DELETE', `/api/projects/${id}`, { cookie: owner.cookie, body: { confirmName: `p${n}` } });
    return { id, envId: e.body.id as string, name: `p${n}`, localId, simpleId: simple.body.script.id as string, runId: run.body.id as string };
  }

  const runTar = () =>
    makeTar([
      {
        name: 'run.json',
        body: JSON.stringify({
          id: `20261113-101500_simple_${++n}`,
          kind: 'script',
          name: 'Simple',
          scriptPath: '/x/simple.yaml',
          scriptHash: scriptHash(SIMPLE_SCRIPT()),
          startedAt: '2026-11-13T01:15:00.000Z',
          finishedAt: '2026-11-13T01:15:01.000Z',
          durationMs: 1000,
          status: 'passed',
          summary: { total: 1, passed: 1, failed: 0, error: 0, skipped: 0 },
          steps: [{ stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 100, expects: [] }],
        }),
      },
    ]);

  /** Actions whose "allowed" outcome may be a 409 business refusal (not a permission denial). */
  const BUSINESS_409: ReadonlySet<ProjectAction> = new Set(['access.request', 'member.leave']);

  const calls: Record<ProjectAction, (w: Who) => Promise<number[]>> = {
    'project.view': async (w) => {
      const f = await fixture();
      const urls = [
        `/api/projects/${f.id}`,
        `/api/projects/${f.id}/members`,
        `/api/projects/${f.id}/environments`,
        `/api/projects/${f.id}/environments/${f.envId}/credentials`,
        `/api/projects/${f.id}/scripts`,
        `/api/projects/${f.id}/scripts/login.yaml`,
        `/api/projects/${f.id}/scripts/login.yaml/versions`,
        `/api/projects/${f.id}/scripts/login.yaml/versions/1`,
        `/api/projects/${f.id}/suites`,
        `/api/projects/${f.id}/activity`,
        `/api/projects/${f.id}/runs`,
        `/api/projects/${f.id}/runs/${f.runId}`,
        `/api/projects/${f.id}/schedules`,
        `/api/projects/${f.id}/access-requests`,
      ];
      return Promise.all(urls.map(async (u) => (await env.req('GET', u, w.auth)).status));
    },
    'run.execute': async (w) => {
      const f = await fixture();
      return [
        (await env.req('POST', `/api/projects/${f.id}/runs/precheck`, { ...w.auth, body: { scriptPath: 'simple.yaml' } })).status,
        (await env.req('POST', `/api/projects/${f.id}/runs`, { ...w.auth, body: { scriptPath: 'simple.yaml' } })).status,
        (await env.req('POST', `/api/projects/${f.id}/runs/${f.runId}/cancel`, w.auth)).status,
      ];
    },
    'run.upload': async (w) => {
      const f = await fixture();
      const body = await runTar();
      return [(await env.req('POST', `/api/projects/${f.id}/runs/upload?scriptPath=simple.yaml`, { ...w.auth, body, headers: { 'content-type': 'application/x-tar' } })).status];
    },
    'schedule.manage': async (w) => {
      const f = await fixture();
      return [(await env.req('POST', `/api/projects/${f.id}/schedules`, { ...w.auth, body: { name: 'Daily', scriptId: f.simpleId, cadence: { kind: 'daily', time: '09:00' } } })).status];
    },
    'script.edit': async (w) => {
      const f = await fixture();
      return [
        (await env.req('PUT', `/api/projects/${f.id}/scripts/new.yaml`, { ...w.auth, body: { source: VALID_SCRIPT } })).status,
        (await env.req('POST', `/api/projects/${f.id}/scripts/login.yaml/revert`, { ...w.auth, body: { version: 1 } })).status,
        (await env.req('POST', `/api/projects/${f.id}/scripts/login.yaml/rename`, { ...w.auth, body: { newPath: 'renamed.yaml' } })).status,
      ];
    },
    'suite.edit': async (w) => {
      const f = await fixture();
      return [(await env.req('POST', `/api/projects/${f.id}/suites`, { ...w.auth, body: { name: 'smoke' } })).status];
    },
    'environment.edit': async (w) => {
      const f = await fixture();
      return [
        (await env.req('POST', `/api/projects/${f.id}/environments`, { ...w.auth, body: { name: 'stg', baseUrl: 'https://stg.example.com' } })).status,
        (await env.req('PATCH', `/api/projects/${f.id}/environments/${f.envId}`, { ...w.auth, body: { vars: { REGION: 'kr' } } })).status,
      ];
    },
    'credential.write': async (w) => {
      const f = await fixture();
      return [(await env.req('PUT', `/api/projects/${f.id}/environments/${f.envId}/credentials/USER_PASSWORD`, { ...w.auth, body: { value: 'pw-123' } })).status];
    },
    'project.update': async (w) => {
      const f = await fixture();
      return [(await env.req('PATCH', `/api/projects/${f.id}`, { ...w.auth, body: { description: 'changed' } })).status];
    },
    'member.manage': async (w) => {
      const f = await fixture();
      return [(await env.req('PUT', `/api/projects/${f.id}/members/${bystander.id}`, { ...w.auth, body: { role: 'editor' } })).status];
    },
    'project.visibility': async (w) => {
      const f = await fixture();
      return [(await env.req('PUT', `/api/projects/${f.id}/visibility`, { ...w.auth, body: { visibility: 'members' } })).status];
    },
    'project.transfer': async (w) => {
      const f = await fixture();
      return [(await env.req('POST', `/api/projects/${f.id}/transfer`, { ...w.auth, body: { userId: bystander.id, myRole: 'editor' } })).status];
    },
    'project.merge': async (w) => {
      const f = await fixture();
      const body = { localProjectId: f.localId };
      return [
        (await env.req('POST', `/api/projects/${f.id}/merge/check`, { ...w.auth, body })).status,
        (await env.req('POST', `/api/projects/${f.id}/merge`, { ...w.auth, body })).status,
      ];
    },
    'access.request': async (w) => {
      const f = await fixture();
      return [(await env.req('POST', `/api/projects/${f.id}/access-requests`, { ...w.auth, body: { role: 'editor', memo: 'please' } })).status];
    },
    'member.leave': async (w) => {
      const f = await fixture();
      return [(await env.req('POST', `/api/projects/${f.id}/leave`, w.auth)).status];
    },
    'project.delete': async (w) => {
      const f = await fixture();
      return [(await env.req('DELETE', `/api/projects/${f.id}`, { ...w.auth, body: { confirmName: f.name } })).status];
    },
    'project.restore': async (w) => {
      const f = await fixture(true);
      return [(await env.req('POST', `/api/projects/${f.id}/restore`, w.auth)).status];
    },
  };

  for (const action of Object.keys(calls) as (keyof typeof calls)[]) {
    it(`${action}: allowed exactly where decide() allows`, async () => {
      for (const w of principals) {
        const expected = decide({ role: w.role, action, tokenPermission: w.tokenPermission });
        const statuses = await calls[action](w);
        for (const s of statuses) {
          if (expected && BUSINESS_409.has(action)) expect(s < 300 || s === 409, `${w.label} → ${action} got ${s}`).toBe(true);
          else if (expected) expect(s, `${w.label} → ${action}`).toBeLessThan(300);
          // Denied: 403, or 404 for a trashed project the caller can't restore (stays invisible).
          else expect([403, 404], `${w.label} → ${action} got ${s}`).toContain(s);
        }
      }
    });
  }

  it('denied writes leave no trace', async () => {
    const f = await fixture();
    const before = (await env.req('GET', `/api/projects/${f.id}/activity`, { cookie: owner.cookie })).body.entries.length;
    await env.req('PUT', `/api/projects/${f.id}/scripts/x.yaml`, { cookie: viewer.cookie, body: { source: VALID_SCRIPT } });
    await env.req('PUT', `/api/projects/${f.id}/environments/${f.envId}/credentials/A`, { cookie: viewer.cookie, body: { value: 'v' } });
    const after = (await env.req('GET', `/api/projects/${f.id}/activity`, { cookie: owner.cookie })).body.entries.length;
    expect(after).toBe(before);
  });

  it('a read token cannot create projects; a read_write token can', async () => {
    expect((await env.req('POST', '/api/projects', { ...principals[5]!.auth, body: { name: 'x' } })).status).toBe(403);
    expect((await env.req('POST', '/api/projects', { ...principals[6]!.auth, body: { name: 'x' } })).status).toBe(201);
  });

  it('GET /api/projects/:id reports myRole and the effective allowed actions', async () => {
    const f = await fixture();
    const asEditorRead = await env.req('GET', `/api/projects/${f.id}`, principals[7]!.auth);
    expect(asEditorRead.body.myRole).toBe('editor');
    expect(asEditorRead.body.can).toEqual(['project.view']);
    const asViewer = await env.req('GET', `/api/projects/${f.id}`, { cookie: viewer.cookie });
    expect(asViewer.body.myRole).toBe('viewer');
    expect(asViewer.body.isMember).toBe(false);
    // Contextual `can`: a non-member viewer cannot "leave"; an invited viewer can; runner may run, not edit.
    expect(asViewer.body.can).toEqual(['project.view', 'access.request']);
    const asInvited = await env.req('GET', `/api/projects/${f.id}`, { cookie: invitedViewer.cookie });
    expect(asInvited.body).toMatchObject({ myRole: 'viewer', isMember: true });
    expect(asInvited.body.can).toContain('member.leave');
    const asRunner = await env.req('GET', `/api/projects/${f.id}`, { cookie: runner.cookie });
    expect(asRunner.body.myRole).toBe('runner');
    expect(asRunner.body.can).toEqual(expect.arrayContaining(['run.execute', 'run.upload', 'access.request', 'member.leave']));
    expect(asRunner.body.can).not.toContain('script.edit');
    expect(asRunner.body.can).not.toContain('schedule.manage');
    const asEditor = await env.req('GET', `/api/projects/${f.id}`, { cookie: editor.cookie });
    expect(asEditor.body.can).not.toContain('access.request');
  });

  it('a deactivated member is excluded from every check (role kept)', async () => {
    const f = await fixture();
    const gone = await env.user('gone@example.com');
    await env.req('PUT', `/api/projects/${f.id}/members/${gone.id}`, { cookie: owner.cookie, body: { role: 'editor' } });
    const admin = await env.adminCookie();
    await env.req('POST', `/api/admin/users/${gone.id}/deactivate`, { cookie: admin });
    expect((await env.req('GET', `/api/projects/${f.id}`, { cookie: gone.cookie })).status).toBe(401);
    expect((await env.req('PUT', `/api/projects/${f.id}/scripts/y.yaml`, { cookie: gone.cookie, body: { source: VALID_SCRIPT } })).status).toBe(401);
    const members = await env.req('GET', `/api/projects/${f.id}/members`, { cookie: owner.cookie });
    expect(members.body.members.find((m: { userId: string }) => m.userId === gone.id)).toMatchObject({ role: 'editor', active: false });
  });

  it('unauthenticated requests are 401', async () => {
    const f = await fixture();
    const r = await env.req('GET', `/api/projects/${f.id}`);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
  });
});
