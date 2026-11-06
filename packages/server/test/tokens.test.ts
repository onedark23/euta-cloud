// SPEC 개인 토큰: prefix euta_ · shown once · hashed at rest · expiry 30/90/180/365 (default 90) ·
// max 10 active · list fields · revocation · expiry · last-used time · session-only management.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/clock.js';
import { apikeys } from '../src/db/schema.js';
import { TestEnv, dumpDatabase } from './helpers.js';

describe('personal tokens', () => {
  let env: TestEnv;
  let u: { id: string; cookie: string };
  beforeAll(async () => {
    env = await TestEnv.create();
    u = await env.user('tok@example.com');
  });
  afterAll(async () => env?.close());

  it('creates a euta_ token shown once, stored only as a hash', async () => {
    const r = await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: 'claude code', permission: 'read' } });
    expect(r.status).toBe(201);
    expect(r.body.token).toMatch(/^euta_[A-Za-z]{48}$/);
    expect(r.body.start).toBe(r.body.token.slice(0, 9)); // "euta_" + 4
    expect(r.body.permission).toBe('read');
    const [row] = await env.ctx.db.select().from(apikeys).where(eq(apikeys.id, r.body.id));
    expect(row!.key).not.toBe(r.body.token);
    expect(row!.key).not.toContain(r.body.token.slice(5));
    const dump = await dumpDatabase(env.dbUrl);
    expect(dump).not.toContain(r.body.token);
    expect(dump).not.toContain(r.body.token.slice(5));
    // Never returned again.
    const list = await env.req('GET', '/api/me/tokens', { cookie: u.cookie });
    expect(list.text).not.toContain(r.body.token);
    expect(list.body.tokens[0]).toMatchObject({ id: r.body.id, name: 'claude code', permission: 'read', lastUsedAt: null });
  });

  it('default expiry is 90 days; only 30/90/180/365 are accepted', async () => {
    const d = await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: 'default', permission: 'read_write' } });
    const days = (new Date(d.body.expiresAt).getTime() - Date.now()) / DAY_MS;
    expect(Math.round(days)).toBe(90);
    for (const n of [30, 180, 365]) {
      const r = await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: `d${n}`, permission: 'read', expiresInDays: n } });
      expect(r.status).toBe(201);
      expect(Math.round((new Date(r.body.expiresAt).getTime() - Date.now()) / DAY_MS)).toBe(n);
    }
    for (const bad of [0, 7, 60, 366, 1000]) {
      expect((await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: 'bad', permission: 'read', expiresInDays: bad } })).status).toBe(422);
    }
    expect((await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: 'bad', permission: 'admin' } })).status).toBe(422);
    expect((await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: 'x'.repeat(41), permission: 'read' } })).status).toBe(422);
  });

  it('records the last-used time', async () => {
    const r = await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: 'used', permission: 'read' } });
    expect((await env.req('GET', '/api/me', { bearer: r.body.token })).body).toMatchObject({ auth: 'token', tokenPermission: 'read' });
    const list = await env.req('GET', '/api/me/tokens', { cookie: u.cookie });
    const t = list.body.tokens.find((x: { id: string }) => x.id === r.body.id);
    expect(t.lastUsedAt).not.toBeNull();
  });

  it('caps active tokens at 10 per account', async () => {
    const v = await env.user('ten@example.com');
    for (let i = 0; i < 10; i++) {
      expect((await env.req('POST', '/api/me/tokens', { cookie: v.cookie, body: { name: `t${i}`, permission: 'read' } })).status).toBe(201);
    }
    const over = await env.req('POST', '/api/me/tokens', { cookie: v.cookie, body: { name: 'eleventh', permission: 'read' } });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('TOKEN_LIMIT');
    // Revoking one frees a slot.
    const list = await env.req('GET', '/api/me/tokens', { cookie: v.cookie });
    expect(list.body.tokens).toHaveLength(10);
    expect((await env.req('DELETE', `/api/me/tokens/${list.body.tokens[0].id}`, { cookie: v.cookie })).status).toBe(204);
    expect((await env.req('POST', '/api/me/tokens', { cookie: v.cookie, body: { name: 'eleventh', permission: 'read' } })).status).toBe(201);
  });

  it('revoked tokens are rejected immediately', async () => {
    const r = await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: 'revoke-me', permission: 'read' } });
    expect((await env.req('GET', '/api/me', { bearer: r.body.token })).status).toBe(200);
    expect((await env.req('DELETE', `/api/me/tokens/${r.body.id}`, { cookie: u.cookie })).status).toBe(204);
    const after = await env.req('GET', '/api/me', { bearer: r.body.token });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('expired tokens are rejected and drop out of the list', async () => {
    const r = await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: 'expiring', permission: 'read', expiresInDays: 30 } });
    await env.ctx.db.update(apikeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apikeys.id, r.body.id));
    expect((await env.req('GET', '/api/me', { bearer: r.body.token })).status).toBe(401);
    const list = await env.req('GET', '/api/me/tokens', { cookie: u.cookie });
    expect(list.body.tokens.find((x: { id: string }) => x.id === r.body.id)).toBeUndefined();
  });

  it('flags tokens expiring within 7 days', async () => {
    const r = await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: 'soon', permission: 'read', expiresInDays: 30 } });
    let t = (await env.req('GET', '/api/me/tokens', { cookie: u.cookie })).body.tokens.find((x: { id: string }) => x.id === r.body.id);
    expect(t.expiringSoon).toBe(false);
    env.clock.advance(24 * DAY_MS);
    t = (await env.req('GET', '/api/me/tokens', { cookie: u.cookie })).body.tokens.find((x: { id: string }) => x.id === r.body.id);
    expect(t.expiringSoon).toBe(true);
    env.clock.offsetMs = 0;
  });

  it('a token cannot list, mint or revoke tokens, nor call admin endpoints', async () => {
    const r = await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: 'rw', permission: 'read_write' } });
    expect((await env.req('GET', '/api/me/tokens', { bearer: r.body.token })).status).toBe(403);
    expect((await env.req('POST', '/api/me/tokens', { bearer: r.body.token, body: { name: 'child', permission: 'read' } })).status).toBe(403);
    expect((await env.req('DELETE', `/api/me/tokens/${r.body.id}`, { bearer: r.body.token })).status).toBe(403);
    expect((await env.req('GET', '/api/admin/users', { bearer: r.body.token })).status).toBe(403);
  });

  it("cannot revoke someone else's token; the plugin's own HTTP endpoints are closed", async () => {
    const other = await env.user('other@example.com');
    const r = await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: 'mine', permission: 'read' } });
    expect((await env.req('DELETE', `/api/me/tokens/${r.body.id}`, { cookie: other.cookie })).status).toBe(404);
    expect((await env.req('POST', '/api/auth/api-key/create', { cookie: u.cookie, body: { name: 'bypass' } })).status).toBe(404);
    expect((await env.req('GET', '/api/auth/api-key/list', { cookie: u.cookie })).status).toBe(404);
  });

  it('garbage bearer values are 401', async () => {
    expect((await env.req('GET', '/api/me', { bearer: 'euta_notarealtoken' })).status).toBe(401);
    expect((await env.req('GET', '/api/me', { bearer: 'nonsense' })).status).toBe(401);
  });
});
