// SPEC 계정 "가입·로그인" (Microsoft) + 완료 기준 C10 — Entra ID login against a stubbed token endpoint:
// new user active at once · same-email account linked (admin, password kept) · pending activated, unproven password dropped ·
// deactivated / other domain / other tenant refused · email sign-up closed · `next` (device) round trip.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { accounts, sessions, users } from '../src/db/schema.js';
import { BASE_URL, TestEnv, cookieFrom, type Res } from './helpers.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const MS = { tenantId: TENANT, clientId: 'euta-client-id', clientSecret: 'euta-client-secret' };
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', kid: 'k' })}.${b64(claims)}.sig`;

/** Claims the stubbed token endpoint puts in the next id token. */
let nextClaims: Record<string, unknown> = {};
const tokenRequests: URLSearchParams[] = [];
const realFetch = globalThis.fetch;

function claims(email: string | undefined, over: Record<string, unknown> = {}) {
  return { sub: `sub-${email ?? 'none'}`, tid: TENANT, name: 'Ms User', ...(email ? { email } : {}), ...over };
}

function setCookies(res: Res): string[] {
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((c) => c.split(';')[0]!);
}

/** Start the login on our server, then come back from "Microsoft" with a code. */
async function msLogin(env: TestEnv, idClaims: Record<string, unknown>, callbackURL = '/projects', errorCallbackURL = '/login') {
  const start = await env.req('POST', '/api/auth/sign-in/social', { body: { provider: 'microsoft', callbackURL, errorCallbackURL } });
  expect(start.status).toBe(200);
  const authorize = new URL(start.body.url);
  nextClaims = idClaims;
  const cb = await env.req('GET', `/api/auth/callback/microsoft?code=the-code&state=${encodeURIComponent(authorize.searchParams.get('state')!)}`, {
    cookie: setCookies(start).join('; '),
  });
  return { authorize, cb, location: String(cb.headers.location ?? ''), cookie: cookieFrom(cb) };
}

describe('Microsoft (Entra ID) login', () => {
  let env: TestEnv;
  let dbUrl: string;
  let ids: { existing: string; waiting: string; gone: string; admin: string };

  beforeAll(async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== TOKEN_URL) return realFetch(input, init);
      tokenRequests.push(new URLSearchParams(String(init?.body ?? '')));
      return new Response(JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: idToken(nextClaims) }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    // Accounts made while email sign-up was open (approval mode), then the server restarts with Microsoft on.
    const before = await TestEnv.create({ approvalMode: true });
    dbUrl = before.dbUrl;
    await before.adminCookie();
    const active = await before.user('existing@example.com');
    const pending = await before.signUp('waiting@example.com');
    const gone = await before.user('gone@example.com');
    await before.req('POST', `/api/admin/users/${gone.id}/deactivate`, { cookie: await before.adminCookie() });
    const [admin] = await before.ctx.db.select().from(users).where(eq(users.email, 'admin@example.com'));
    ids = { existing: active.id, waiting: pending.body.user.id, gone: gone.id, admin: admin!.id };
    await before.app.close();
    await before.internal.close();
    env = await TestEnv.create({ approvalMode: true, dbUrl, config: { microsoft: MS } });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await env?.close();
  });

  it('sends people to the configured tenant with sign-in scopes only', async () => {
    const start = await env.req('POST', '/api/auth/sign-in/social', { body: { provider: 'microsoft', callbackURL: '/projects' } });
    const u = new URL(start.body.url);
    expect(`${u.origin}${u.pathname}`).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
    expect(u.searchParams.get('client_id')).toBe(MS.clientId);
    expect(u.searchParams.get('redirect_uri')).toBe(`${BASE_URL}/api/auth/callback/microsoft`);
    expect(u.searchParams.get('scope')).toBe('openid profile email');
    expect(u.searchParams.get('prompt')).toBe('select_account');
  });

  it('publishes microsoftLogin and closes email sign-up', async () => {
    expect((await env.req('GET', '/api/config')).body).toMatchObject({ microsoftLogin: true });
    const r = await env.signUp('newbie@example.com');
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED');
  });

  it('first login creates an active account and a session, back to callbackURL', async () => {
    const { cb, location, cookie } = await msLogin(env, claims('New.Person@ExAmple.com'));
    expect(cb.status).toBe(302);
    expect(location).toBe('/projects');
    expect(cookie).toBeTruthy();
    const [u] = await env.ctx.db.select().from(users).where(eq(users.email, 'new.person@example.com'));
    expect(u).toMatchObject({ status: 'active', isAdmin: false, name: 'Ms User' });
    const me = await env.req('GET', '/api/me', { cookie: cookie! });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('new.person@example.com');
    // The code was exchanged with our secret and the same redirect URI.
    const t = tokenRequests.at(-1)!;
    expect(t.get('code')).toBe('the-code');
    expect(t.get('redirect_uri')).toBe(`${BASE_URL}/api/auth/callback/microsoft`);
  });

  it('falls back to the UPN when the optional email claim is missing', async () => {
    const { cookie } = await msLogin(env, claims(undefined, { sub: 'sub-upn', preferred_username: 'Upn.Only@example.com' }));
    expect(cookie).toBeTruthy();
    const [u] = await env.ctx.db.select().from(users).where(eq(users.email, 'upn.only@example.com'));
    expect(u?.status).toBe('active');
  });

  it('links an existing same-email account (password login kept)', async () => {
    const { cookie } = await msLogin(env, claims('Existing@ExAmple.com'));
    expect(cookie).toBeTruthy();
    const rows = await env.ctx.db.select().from(users).where(eq(users.email, 'existing@example.com'));
    expect(rows.map((r) => r.id)).toEqual([ids.existing]);
    const acc = await env.ctx.db.select().from(accounts).where(eq(accounts.userId, ids.existing));
    expect(acc.map((a) => a.providerId).sort()).toEqual(['credential', 'microsoft']);
    expect((await env.signIn('existing@example.com')).cookie).toBeTruthy();
  });

  it('keeps the administrator when the admin signs in with Microsoft', async () => {
    const { cookie } = await msLogin(env, claims('admin@example.com'));
    const me = await env.req('GET', '/api/me', { cookie: cookie! });
    expect(me.body).toMatchObject({ id: ids.admin, isAdmin: true });
    // Approval mode never verified the admin's mail, yet the administrator keeps the password login.
    expect((await env.signIn('admin@example.com')).cookie).toBeTruthy();
  });

  it('activates a pending account on Microsoft login and drops its unproven password', async () => {
    const { cookie, location } = await msLogin(env, claims('waiting@example.com'));
    expect(location).toBe('/projects');
    expect(cookie).toBeTruthy();
    const [u] = await env.ctx.db.select().from(users).where(eq(users.id, ids.waiting));
    expect(u).toMatchObject({ status: 'active', emailVerified: true });
    // Whoever typed that password at sign-up never proved the mailbox — it no longer opens the account.
    const acc = await env.ctx.db.select().from(accounts).where(eq(accounts.userId, ids.waiting));
    expect(acc.map((a) => a.providerId)).toEqual(['microsoft']);
    expect((await env.signIn('waiting@example.com')).cookie).toBeNull();
  });

  it('refuses a deactivated account — error back to the login page, no session', async () => {
    const { location, cookie } = await msLogin(env, claims('gone@example.com'), '/projects', '/login?next=%2Fprojects');
    expect(cookie).toBeNull();
    const back = new URL(location, BASE_URL);
    expect(back.pathname).toBe('/login');
    expect(back.searchParams.get('next')).toBe('/projects');
    expect(back.searchParams.get('error')).toBe('ACCOUNT_DEACTIVATED');
    expect(await env.ctx.db.select().from(sessions).where(eq(sessions.userId, ids.gone))).toEqual([]);
    const [u] = await env.ctx.db.select().from(users).where(eq(users.id, ids.gone));
    expect(u?.status).toBe('deactivated');
  });

  it('refuses addresses outside the allowed domain', async () => {
    const { location, cookie } = await msLogin(env, claims('guest@partner.example'));
    expect(cookie).toBeNull();
    // Better Auth reports a failed user creation by its message (spaces → "_"), not by the error code.
    expect(new URL(location, BASE_URL).searchParams.get('error')).toMatch(/^sign-up_is_limited_to_/);
    expect(await env.ctx.db.select().from(users).where(eq(users.email, 'guest@partner.example'))).toEqual([]);
  });

  it('refuses a token from another tenant', async () => {
    const { location, cookie } = await msLogin(env, claims('other.tenant@example.com', { tid: '99999999-0000-0000-0000-000000000000' }));
    expect(cookie).toBeNull();
    expect(new URL(location, BASE_URL).searchParams.get('error')).toBeTruthy();
    expect(await env.ctx.db.select().from(users).where(eq(users.email, 'other.tenant@example.com'))).toEqual([]);
  });

  it('returns to the device approval page (local app login)', async () => {
    const { location, cookie } = await msLogin(env, claims('device.user@example.com'), '/device?user_code=ABCD-EFGH');
    expect(cookie).toBeTruthy();
    expect(location).toBe('/device?user_code=ABCD-EFGH');
  });

  it('never writes the client secret to the logs', async () => {
    expect(env.logs.join('\n')).not.toContain(MS.clientSecret);
  });
});

describe('Microsoft login over unverified email sign-ups (mail mode)', () => {
  let env: TestEnv;
  let squatted: string;

  beforeAll(async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url !== TOKEN_URL) return realFetch(input, init);
      return new Response(JSON.stringify({ access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: idToken(nextClaims) }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    // Someone signs up with a colleague's address and never opens the verification mail.
    const before = await TestEnv.create();
    const up = await before.signUp('victim@example.com');
    squatted = up.body.user.id;
    const dbUrl = before.dbUrl;
    await before.app.close();
    await before.internal.close();
    env = await TestEnv.create({ dbUrl, config: { microsoft: MS } });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await env?.close();
  });

  it('the real owner gets in with Microsoft; the unproven password stops working', async () => {
    const { cookie } = await msLogin(env, claims('victim@example.com'));
    expect(cookie).toBeTruthy();
    const [u] = await env.ctx.db.select().from(users).where(eq(users.id, squatted));
    expect(u).toMatchObject({ status: 'active', emailVerified: true });
    const acc = await env.ctx.db.select().from(accounts).where(eq(accounts.userId, squatted));
    expect(acc.map((a) => a.providerId)).toEqual(['microsoft']);
    expect((await env.signIn('victim@example.com')).cookie).toBeNull();
  });
});
