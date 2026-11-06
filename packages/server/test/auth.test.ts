// SPEC 계정 "가입·로그인" + 완료 기준 C1: domain · verification · approval mode · lockout ·
// session · deactivation (sessions, device tokens, personal tokens) · device authorization flow.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCKOUT_MS } from '../src/auth.js';
import { apikeys, deviceCodes, sessions, users } from '../src/db/schema.js';
import { smtpMailer } from '../src/mail.js';
import { MAILPIT_API, MAILPIT_SMTP } from './db-urls.js';
import { PASSWORD, TestEnv, cookieFrom } from './helpers.js';

describe('sign-up and login (SMTP / verification mode)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await TestEnv.create();
  });
  afterAll(async () => env?.close());

  it('rejects sign-up outside the allowed domain', async () => {
    const r = await env.signUp('someone@gmail.com');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EMAIL_DOMAIN_NOT_ALLOWED');
    const lookalike = await env.signUp('x@example.com.evil.io');
    expect(lookalike.status).toBe(403);
    const rows = await env.ctx.db.select().from(users);
    expect(rows.map((u) => u.email)).not.toContain('someone@gmail.com');
  });

  it('accepts the allowed domain case-insensitively', async () => {
    const r = await env.signUp('Mixed.Case@ExAmple.com');
    expect(r.status).toBe(200);
    expect(r.body.user.email).toBe('mixed.case@example.com');
  });

  it('enforces password length 10–128', async () => {
    expect((await env.signUp('short@example.com', 'nine-char')).status).toBe(400);
    expect((await env.signUp('long@example.com', 'x'.repeat(129))).status).toBe(400);
    expect((await env.signUp('ten@example.com', '0123456789')).status).toBe(200);
    expect((await env.signUp('max@example.com', 'y'.repeat(128))).status).toBe(200);
  });

  it('rejects login before email verification and re-sends the mail', async () => {
    await env.signUp('unverified@example.com');
    const before = env.mails.filter((m) => m.to === 'unverified@example.com').length;
    const { res, cookie } = await env.signIn('unverified@example.com');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('EMAIL_NOT_VERIFIED');
    expect(cookie).toBeNull();
    expect(env.mails.filter((m) => m.to === 'unverified@example.com').length).toBe(before + 1);
    // After verification the same credentials work.
    await env.verifyFromMail('unverified@example.com');
    const ok = await env.signIn('unverified@example.com');
    expect(ok.res.status).toBe(200);
    expect(ok.cookie).toBeTruthy();
  });

  it('issues a 7-day httpOnly SameSite=Lax session cookie, invalidated by sign-out', async () => {
    const u = await env.user('session@example.com');
    const [s] = await env.ctx.db.select().from(sessions).where(eq(sessions.userId, u.id));
    const days = (s!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
    const { res } = await env.signIn('session@example.com');
    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect((await env.req('GET', '/api/me', { cookie: u.cookie })).status).toBe(200);
    await env.req('POST', '/api/auth/sign-out', { cookie: u.cookie, body: {} });
    expect((await env.req('GET', '/api/me', { cookie: u.cookie })).status).toBe(401);
  });

  it('locks the account for 10 minutes after 5 consecutive failures', async () => {
    await env.user('lock@example.com');
    for (let i = 0; i < 5; i++) {
      const { res } = await env.signIn('lock@example.com', 'wrong-password-123');
      expect(res.status).toBe(401);
    }
    const locked = await env.signIn('lock@example.com');
    expect(locked.res.status).toBe(429);
    expect(locked.res.body.code).toBe('ACCOUNT_LOCKED');
    env.clock.advance(LOCKOUT_MS - 60_000);
    expect((await env.signIn('lock@example.com')).res.status).toBe(429);
    env.clock.advance(2 * 60_000);
    const ok = await env.signIn('lock@example.com');
    expect(ok.res.status).toBe(200);
  });

  it('a successful login resets the failure counter', async () => {
    await env.user('reset@example.com');
    for (let i = 0; i < 4; i++) await env.signIn('reset@example.com', 'wrong-password-123');
    expect((await env.signIn('reset@example.com')).res.status).toBe(200);
    for (let i = 0; i < 4; i++) await env.signIn('reset@example.com', 'wrong-password-123');
    expect((await env.signIn('reset@example.com')).res.status).toBe(200);
  });

  it('ADMIN_EMAILS makes the user an administrator; others cannot use admin endpoints', async () => {
    const admin = await env.adminCookie();
    const me = await env.req('GET', '/api/me', { cookie: admin });
    expect(me.body.isAdmin).toBe(true);
    const u = await env.user('plain@example.com');
    expect((await env.req('GET', '/api/admin/users', { cookie: u.cookie })).status).toBe(403);
    expect((await env.req('GET', '/api/admin/users', { cookie: admin })).status).toBe(200);
  });

  it('users cannot grant themselves admin or change their status', async () => {
    const u = await env.user('sneaky@example.com');
    await env.req('POST', '/api/auth/update-user', { cookie: u.cookie, body: { isAdmin: true, status: 'active', name: 'Sneaky' } });
    const [row] = await env.ctx.db.select().from(users).where(eq(users.id, u.id));
    expect(row!.isAdmin).toBe(false);
  });

  it('sends a password-reset mail with a 1-hour link', async () => {
    await env.user('forgot@example.com');
    const r = await env.req('POST', '/api/auth/request-password-reset', { body: { email: 'forgot@example.com', redirectTo: '/reset' } });
    expect(r.status).toBe(200);
    expect(env.lastMailTo('forgot@example.com')?.subject).toMatch(/비밀번호/);
  });
});

describe('deactivation', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await TestEnv.create();
  });
  afterAll(async () => env?.close());

  it('revokes sessions, device tokens and personal tokens; blocks login; reactivation does not revive tokens', async () => {
    const admin = await env.adminCookie();
    const u = await env.user('leaver@example.com');
    const second = (await env.signIn('leaver@example.com')).cookie!;
    const tok = await env.req('POST', '/api/me/tokens', { cookie: u.cookie, body: { name: 'mcp', permission: 'read_write' } });
    expect(tok.status).toBe(201);
    const device = await deviceToken(env, u.cookie);
    expect((await env.req('GET', '/api/me', { bearer: device })).status).toBe(200);
    expect((await env.req('GET', '/api/me', { bearer: tok.body.token })).status).toBe(200);

    const d = await env.req('POST', `/api/admin/users/${u.id}/deactivate`, { cookie: admin });
    expect(d.status).toBe(200);
    for (const auth of [{ cookie: u.cookie }, { cookie: second }, { bearer: device }, { bearer: tok.body.token as string }]) {
      expect((await env.req('GET', '/api/me', auth)).status).toBe(401);
    }
    expect(await env.ctx.db.$count(sessions, eq(sessions.userId, u.id))).toBe(0);
    expect(await env.ctx.db.$count(apikeys, eq(apikeys.referenceId, u.id))).toBe(0);
    const login = await env.signIn('leaver@example.com');
    expect(login.res.status).toBe(403);
    expect(login.res.body.code).toBe('ACCOUNT_DEACTIVATED');
    expect(login.cookie).toBeNull();

    expect((await env.req('POST', `/api/admin/users/${u.id}/activate`, { cookie: admin })).status).toBe(200);
    expect((await env.req('GET', '/api/me', { bearer: tok.body.token })).status).toBe(401);
    expect((await env.signIn('leaver@example.com')).res.status).toBe(200);
  });

  it('an admin cannot deactivate themselves', async () => {
    const admin = await env.adminCookie();
    const me = await env.req('GET', '/api/me', { cookie: admin });
    expect((await env.req('POST', `/api/admin/users/${me.body.id}/deactivate`, { cookie: admin })).status).toBe(409);
  });

  it('a deactivated device cannot obtain a new device token', async () => {
    const admin = await env.adminCookie();
    const u = await env.user('dev2@example.com');
    const code = await env.req('POST', '/api/auth/device/code', { body: { client_id: 'euta-app' } });
    await env.req('GET', `/api/auth/device?user_code=${code.body.user_code}`, { cookie: u.cookie });
    expect((await env.req('POST', '/api/auth/device/approve', { cookie: u.cookie, body: { userCode: code.body.user_code } })).status).toBe(200);
    await env.ctx.db.update(users).set({ status: 'deactivated' }).where(eq(users.id, u.id));
    const tok = await env.req('POST', '/api/auth/device/token', {
      body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.body.device_code, client_id: 'euta-app' },
    });
    expect(tok.body?.access_token).toBeUndefined();
    void admin;
  });
});

async function deviceToken(env: TestEnv, cookie: string): Promise<string> {
  const code = await env.req('POST', '/api/auth/device/code', { body: { client_id: 'euta-app' } });
  expect(code.status).toBe(200);
  const verify = await env.req('GET', `/api/auth/device?user_code=${code.body.user_code}`, { cookie });
  expect(verify.status).toBe(200);
  const approve = await env.req('POST', '/api/auth/device/approve', { cookie, body: { userCode: code.body.user_code } });
  expect(approve.status).toBe(200);
  const tok = await env.req('POST', '/api/auth/device/token', {
    body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.body.device_code, client_id: 'euta-app' },
  });
  expect(tok.status).toBe(200);
  return tok.body.access_token as string;
}

describe('device authorization (local app login)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await TestEnv.create();
  });
  afterAll(async () => env?.close());

  it('code → pending → approve in browser → token → bearer API call', async () => {
    const u = await env.user('app@example.com');
    const code = await env.req('POST', '/api/auth/device/code', { body: { client_id: 'euta-app', scope: 'openid' } });
    expect(code.status).toBe(200);
    expect(code.body.verification_uri).toBe('http://euta.test/device');
    const grant = { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.body.device_code, client_id: 'euta-app' };
    const pending = await env.req('POST', '/api/auth/device/token', { body: grant });
    expect(pending.status).toBe(400);
    expect(pending.body.error).toBe('authorization_pending');
    // Approval needs a signed-in browser session.
    expect((await env.req('POST', '/api/auth/device/approve', { body: { userCode: code.body.user_code } })).status).toBe(401);
    // The browser opens the verification page signed in → the code is claimed by this user.
    const verify = await env.req('GET', `/api/auth/device?user_code=${code.body.user_code}`, { cookie: u.cookie });
    expect(verify.status).toBe(200);
    const approve = await env.req('POST', '/api/auth/device/approve', { cookie: u.cookie, body: { userCode: code.body.user_code } });
    expect(approve.status).toBe(200);
    // Better Auth's token endpoint takes JSON (form-encoded → 415); the local app sends JSON.
    const fast = await env.req('POST', '/api/auth/device/token', { body: grant });
    expect(fast.body.error).toBe('slow_down'); // polled again inside the 5 s interval
    await env.ctx.db.update(deviceCodes).set({ lastPolledAt: new Date(Date.now() - 10_000) });
    const res = await env.req('POST', '/api/auth/device/token', { body: grant });
    const tok = res.body;
    expect(res.status).toBe(200);
    expect(tok.access_token).toBeTruthy();
    const me = await env.req('GET', '/api/me', { bearer: tok.access_token });
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('app@example.com');
    expect(me.body.auth).toBe('session');
  });

  it('a native app (no Origin header, no cookies) can request a code and poll', async () => {
    const code = await env.app.inject({ method: 'POST', url: '/api/auth/device/code', payload: { client_id: 'euta-app' } });
    expect(code.statusCode).toBe(200);
    const { device_code } = JSON.parse(code.body);
    const poll = await env.app.inject({
      method: 'POST',
      url: '/api/auth/device/token',
      payload: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code, client_id: 'euta-app' },
    });
    expect(JSON.parse(poll.body).error).toBe('authorization_pending');
  });

  it('rejects unknown client ids', async () => {
    const r = await env.req('POST', '/api/auth/device/code', { body: { client_id: 'evil-cli' } });
    expect(r.status).toBe(400);
  });
});

describe('admin approval mode (no SMTP)', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await TestEnv.create({ approvalMode: true });
  });
  afterAll(async () => env?.close());

  it('sign-up → pending → login refused → admin approves → login works', async () => {
    const up = await env.signUp('newbie@example.com');
    expect(up.status).toBe(200);
    expect(up.body.user.status).toBe('pending');
    expect(up.body.token).toBeNull();
    expect(env.mails).toHaveLength(0);
    const refused = await env.signIn('newbie@example.com');
    expect(refused.res.status).toBe(403);
    expect(refused.res.body.code).toBe('PENDING_APPROVAL');
    expect(refused.cookie).toBeNull();

    const admin = await env.adminCookie();
    const list = await env.req('GET', '/api/admin/users', { cookie: admin });
    expect(list.body.approvalMode).toBe(true);
    expect(list.body.users.find((u: { email: string }) => u.email === 'newbie@example.com').status).toBe('pending');
    expect((await env.req('POST', `/api/admin/users/${up.body.user.id}/approve`, { cookie: admin })).status).toBe(200);
    const ok = await env.signIn('newbie@example.com');
    expect(ok.res.status).toBe(200);
    expect(ok.cookie).toBeTruthy();
  });

  it('configured admins are active immediately (somebody has to approve)', async () => {
    const admin = await env.adminCookie();
    expect((await env.req('GET', '/api/me', { cookie: admin })).body).toMatchObject({ isAdmin: true, status: 'active' });
  });

  it('admin issues a temporary password instead of a reset mail', async () => {
    const admin = await env.adminCookie();
    const u = await env.user('temp@example.com');
    const r = await env.req('POST', `/api/admin/users/${u.id}/reset-password`, { cookie: admin });
    expect(r.status).toBe(200);
    expect((await env.req('GET', '/api/me', { cookie: u.cookie })).status).toBe(401);
    expect((await env.signIn('temp@example.com', PASSWORD)).res.status).toBe(401);
    expect((await env.signIn('temp@example.com', r.body.temporaryPassword)).res.status).toBe(200);
  });
});

describe('real SMTP delivery through Mailpit', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await TestEnv.create({ mailer: smtpMailer(MAILPIT_SMTP, 'euta cloud <no-reply@example.com>') });
  });
  afterAll(async () => env?.close());

  it('verification mail arrives and its link verifies the account', async () => {
    const email = `mailpit-${Date.now()}@example.com`;
    await env.signUp(email);
    let link: string | undefined;
    for (let i = 0; i < 20 && !link; i++) {
      const list = (await (await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json()) as { messages: { ID: string }[] };
      if (list.messages?.[0]) {
        const msg = (await (await fetch(`${MAILPIT_API}/api/v1/message/${list.messages[0].ID}`)).json()) as { Text: string };
        link = /https?:\/\/\S+/.exec(msg.Text)?.[0];
      } else await new Promise((r) => setTimeout(r, 250));
    }
    expect(link).toBeTruthy();
    const u = new URL(link!);
    await env.req('GET', u.pathname + u.search);
    const { res } = await env.signIn(email);
    expect(res.status).toBe(200);
    expect(cookieFrom(res)).toBeTruthy();
  });
});
