// SPEC 프로젝트: create/list/update · members (last owner) · trash 30 days → restore / purge.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/clock.js';
import { credentials, projects, scripts } from '../src/db/schema.js';
import { purgeExpired } from '../src/services/purge.js';
import { TestEnv, VALID_SCRIPT } from './helpers.js';

describe('projects', () => {
  let env: TestEnv;
  let a: { id: string; cookie: string };
  let b: { id: string; cookie: string };
  beforeAll(async () => {
    env = await TestEnv.create();
    a = await env.user('alice@example.com');
    b = await env.user('bob@example.com');
  });
  afterAll(async () => env?.close());

  it('creator becomes owner; everyone in the org sees it; "mine" lists invited only', async () => {
    const p = await env.req('POST', '/api/projects', { cookie: a.cookie, body: { name: 'Shop', description: '첫 대상', browser: { engine: 'chromium' }, testRules: '게시 금지' } });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ name: 'Shop', myRole: 'owner', testRules: '게시 금지' });
    const allB = await env.req('GET', '/api/projects', { cookie: b.cookie });
    expect(allB.body.projects.find((x: { id: string }) => x.id === p.body.id)).toMatchObject({ myRole: 'viewer' });
    const mineB = await env.req('GET', '/api/projects?scope=mine', { cookie: b.cookie });
    expect(mineB.body.projects).toHaveLength(0);
    const act = await env.req('GET', `/api/projects/${p.body.id}/activity`, { cookie: b.cookie });
    expect(act.body.entries[0]).toMatchObject({ kind: 'project.created', actor: { type: 'user', label: 'alice' } });
  });

  it('validates fields (422) and 404s unknown projects', async () => {
    expect((await env.req('POST', '/api/projects', { cookie: a.cookie, body: { name: '' } })).status).toBe(422);
    expect((await env.req('POST', '/api/projects', { cookie: a.cookie, body: { name: 'x'.repeat(81) } })).status).toBe(422);
    expect((await env.req('POST', '/api/projects', { cookie: a.cookie, body: { name: 'w', teamsWebhookUrl: 'http://insecure' } })).status).toBe(422);
    const r = await env.req('GET', '/api/projects/nope', { cookie: a.cookie });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: 'project not found' } });
  });

  it('members: invite, change role, last owner protected, remove', async () => {
    const p = (await env.req('POST', '/api/projects', { cookie: a.cookie, body: { name: 'Team' } })).body;
    const put = await env.req('PUT', `/api/projects/${p.id}/members/${b.id}`, { cookie: a.cookie, body: { role: 'editor' } });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ userId: b.id, role: 'editor', active: true });
    expect((await env.req('GET', `/api/projects/${p.id}/members/${b.id}`, { cookie: b.cookie })).body.role).toBe('editor');
    // Only owner left → cannot demote / remove.
    const demote = await env.req('PUT', `/api/projects/${p.id}/members/${a.id}`, { cookie: a.cookie, body: { role: 'editor' } });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('LAST_OWNER');
    expect((await env.req('DELETE', `/api/projects/${p.id}/members/${a.id}`, { cookie: a.cookie })).status).toBe(409);
    // Second owner → now a can step down.
    await env.req('PUT', `/api/projects/${p.id}/members/${b.id}`, { cookie: a.cookie, body: { role: 'owner' } });
    expect((await env.req('PUT', `/api/projects/${p.id}/members/${a.id}`, { cookie: a.cookie, body: { role: 'editor' } })).status).toBe(200);
    expect((await env.req('DELETE', `/api/projects/${p.id}/members/${a.id}`, { cookie: b.cookie })).status).toBe(204);
    expect((await env.req('GET', `/api/projects/${p.id}`, { cookie: a.cookie })).body.myRole).toBe('viewer');
    expect((await env.req('PUT', `/api/projects/${p.id}/members/unknown-user`, { cookie: b.cookie, body: { role: 'editor' } })).status).toBe(404);
    expect((await env.req('PUT', `/api/projects/${p.id}/members/${a.id}`, { cookie: b.cookie, body: { role: 'admin' } })).status).toBe(422);
  });

  it('PATCH validates the default environment belongs to the project', async () => {
    const p = (await env.req('POST', '/api/projects', { cookie: a.cookie, body: { name: 'Envs' } })).body;
    const e = (await env.req('POST', `/api/projects/${p.id}/environments`, { cookie: a.cookie, body: { name: 'dev', baseUrl: 'https://dev.example.com' } })).body;
    expect((await env.req('PATCH', `/api/projects/${p.id}`, { cookie: a.cookie, body: { defaultEnvironmentId: 'other' } })).status).toBe(422);
    const ok = await env.req('PATCH', `/api/projects/${p.id}`, { cookie: a.cookie, body: { defaultEnvironmentId: e.id, name: 'Envs 2' } });
    expect(ok.body).toMatchObject({ defaultEnvironmentId: e.id, name: 'Envs 2' });
  });

  it('delete needs the name; trash hides it; owner restores within 30 days', async () => {
    const p = (await env.req('POST', '/api/projects', { cookie: a.cookie, body: { name: 'Trash me' } })).body;
    expect((await env.req('DELETE', `/api/projects/${p.id}`, { cookie: a.cookie, body: { confirmName: 'wrong' } })).status).toBe(422);
    expect((await env.req('DELETE', `/api/projects/${p.id}`, { cookie: a.cookie, body: { confirmName: 'Trash me' } })).status).toBe(204);
    expect((await env.req('GET', `/api/projects/${p.id}`, { cookie: a.cookie })).status).toBe(404);
    expect((await env.req('GET', `/api/projects/${p.id}/scripts`, { cookie: a.cookie })).status).toBe(404);
    expect((await env.req('GET', '/api/projects', { cookie: a.cookie })).body.projects.map((x: { id: string }) => x.id)).not.toContain(p.id);
    const trash = await env.req('GET', '/api/projects?trashed=1', { cookie: a.cookie });
    expect(trash.body.projects.map((x: { id: string }) => x.id)).toContain(p.id);
    expect((await env.req('GET', '/api/projects?trashed=1', { cookie: b.cookie })).body.projects).toHaveLength(0);
    expect((await env.req('POST', `/api/projects/${p.id}/restore`, { cookie: b.cookie })).status).toBe(404);
    env.clock.advance(29 * DAY_MS);
    const r = await env.req('POST', `/api/projects/${p.id}/restore`, { cookie: a.cookie });
    expect(r.status).toBe(200);
    expect(r.body.deletedAt).toBeUndefined();
    expect((await env.req('GET', `/api/projects/${p.id}`, { cookie: a.cookie })).status).toBe(200);
    expect((await env.req('POST', `/api/projects/${p.id}/restore`, { cookie: a.cookie })).status).toBe(409);
    env.clock.offsetMs = 0;
  });

  it('after 30 days restore is refused and the purge deletes everything', async () => {
    const p = (await env.req('POST', '/api/projects', { cookie: a.cookie, body: { name: 'Gone' } })).body;
    const e = (await env.req('POST', `/api/projects/${p.id}/environments`, { cookie: a.cookie, body: { name: 'dev', baseUrl: 'https://dev.example.com' } })).body;
    await env.req('PUT', `/api/projects/${p.id}/environments/${e.id}/credentials/PW`, { cookie: a.cookie, body: { value: 'v' } });
    await env.req('PUT', `/api/projects/${p.id}/scripts/a.yaml`, { cookie: a.cookie, body: { source: VALID_SCRIPT } });
    await env.req('DELETE', `/api/projects/${p.id}`, { cookie: a.cookie, body: { confirmName: 'Gone' } });
    env.clock.advance(30 * DAY_MS + 60_000);
    expect((await env.req('POST', `/api/projects/${p.id}/restore`, { cookie: a.cookie })).status).toBe(404);
    expect((await env.req('GET', '/api/projects?trashed=1', { cookie: a.cookie })).body.projects.map((x: { id: string }) => x.id)).not.toContain(p.id);
    const r = await purgeExpired(env.ctx);
    expect(r.projects).toBeGreaterThanOrEqual(1);
    expect(await env.ctx.db.$count(projects, eq(projects.id, p.id))).toBe(0);
    expect(await env.ctx.db.$count(scripts, eq(scripts.projectId, p.id))).toBe(0);
    expect(await env.ctx.db.$count(credentials, eq(credentials.environmentId, e.id))).toBe(0);
    env.clock.offsetMs = 0;
  });

  it('a project inside the window survives the purge', async () => {
    const p = (await env.req('POST', '/api/projects', { cookie: a.cookie, body: { name: 'Keep' } })).body;
    await env.req('DELETE', `/api/projects/${p.id}`, { cookie: a.cookie, body: { confirmName: 'Keep' } });
    env.clock.advance(10 * DAY_MS);
    await purgeExpired(env.ctx);
    expect(await env.ctx.db.$count(projects, eq(projects.id, p.id))).toBe(1);
    env.clock.offsetMs = 0;
  });
});
