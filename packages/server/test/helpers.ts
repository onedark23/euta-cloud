// Test harness: a fresh database per test file, an app with injectable clock/DNS/mailer, captured
// logs and every response body (for the plaintext-secret scans), and auth helpers.
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import pg from 'pg';
import { buildApp, type AppDeps } from '../src/app.js';
import type { Clock } from '../src/clock.js';
import type { Config } from '../src/config.js';
import type { AppContext } from '../src/context.js';
import type { MailMessage, Mailer } from '../src/mail.js';
import type { HostResolver } from '../src/services/address-check.js';
import type { FetchLike } from '../src/services/notify.js';
import { ADMIN_URL, TEMPLATE_DB, dbUrl } from './db-urls.js';
import type { FastifyInstance } from 'fastify';

export const BASE_URL = 'http://euta.test';
export const TEST_RUNNER_TOKEN = 'test-runner-token-0123456789abcdef';
export const PASSWORD = 'correct-horse-battery';
export const VALID_SCRIPT = `version: 1
name: Login
target:
  baseUrl: \${env.BASE_URL}
steps:
  - goto: /login
  - fill: { target: { label: 이메일 }, value: "\${secrets.USER_EMAIL}" }
  - click: { target: { role: button, name: 로그인 } }
  - expect: { url: /dashboard }
`;
export const INVALID_SCRIPT = `version: 1
name: Broken
steps:
  - clikc: { target: { text: nope } }
`;

export class MutableClock implements Clock {
  offsetMs = 0;
  now() {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number) {
    this.offsetMs += ms;
  }
  /** Jump to an absolute time (real time keeps passing from there). */
  set(at: Date | string) {
    this.offsetMs = new Date(at).getTime() - Date.now();
  }
}

export interface WebhookCall {
  url: string;
  body: any;
  raw: string;
}

/** Fake outbound HTTP for Teams webhooks: records calls, answers with `respond` (default 202). */
export class FakeWebhook {
  readonly calls: WebhookCall[] = [];
  respond: (call: WebhookCall) => { status: number; retryAfter?: string } | Error = () => ({ status: 202 });
  readonly fetch: FetchLike = async (url, init) => {
    const call = { url, raw: init.body, body: JSON.parse(init.body) };
    this.calls.push(call);
    const r = this.respond(call);
    if (r instanceof Error) throw r;
    return { status: r.status, headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? (r.retryAfter ?? null) : null) } };
  };
}

/** Public by default; hosts listed in `privateHosts` resolve to 10.0.0.5. */
export function fakeResolver(privateHosts: string[] = []): HostResolver {
  return async (host) => (privateHosts.includes(host) ? ['10.0.0.5'] : ['93.184.216.34']);
}

export async function createDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const name = `euta_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database "${name}" template "${TEMPLATE_DB}"`);
  await admin.end();
  return {
    url: dbUrl(name),
    drop: async () => {
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`drop database if exists "${name}" with (force)`);
      await c.end();
    },
  };
}

export function testConfig(databaseUrl: string, over: Partial<Config> = {}): Config {
  return {
    databaseUrl,
    baseUrl: BASE_URL,
    host: '127.0.0.1',
    port: 0,
    authSecret: 'test-secret-test-secret-test-secret-0123456789',
    credentialsKey: Buffer.alloc(32, 7),
    allowedEmailDomains: ['example.com'],
    adminEmails: ['admin@example.com'],
    microsoft: null,
    smtpUrl: null,
    mailFrom: 'euta cloud <no-reply@example.com>',
    rateLimit: false,
    webDist: null,
    deviceClientIds: ['euta-app'],
    feedRetentionDays: 7,
    logLevel: 'debug',
    internalPort: 0,
    runnerToken: TEST_RUNNER_TOKEN,
    allowPrivateTargets: false,
    resultsDir: mkdtempSync(join(tmpdir(), 'euta-results-')),
    resultRetentionDays: 30,
    resultMaxTotalBytes: 12 * 1024 ** 3,
    resultMaxRunBytes: 64 * 1024 * 1024,
    leaseTtlMs: 120_000,
    runnerHeartbeatMs: 5_000,
    updatesDir: mkdtempSync(join(tmpdir(), 'euta-updates-')),
    minAppVersion: null,
    appMirror: null,
    ...over,
  };
}

export interface Res {
  status: number;
  body: any;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

export interface ReqOpts {
  body?: unknown;
  cookie?: string;
  bearer?: string;
  headers?: Record<string, string>;
}

export class TestEnv {
  readonly mails: MailMessage[] = [];
  readonly logs: string[] = [];
  readonly responses: string[] = [];
  readonly webhook = new FakeWebhook();
  app!: FastifyInstance;
  internal!: FastifyInstance;
  ctx!: AppContext;
  private dropDb: (() => Promise<void>) | null = null;
  dbUrl = '';

  constructor(readonly clock = new MutableClock()) {}

  static async create(
    opts: { approvalMode?: boolean; mailer?: Mailer | null; resolveHost?: HostResolver; config?: Partial<Config>; dbUrl?: string } = {},
  ): Promise<TestEnv> {
    const env = new TestEnv();
    if (opts.dbUrl) env.dbUrl = opts.dbUrl;
    else {
      const db = await createDatabase();
      env.dbUrl = db.url;
      env.dropDb = db.drop;
    }
    const capture: Mailer = { send: async (m) => void env.mails.push(m) };
    const mailer = opts.mailer !== undefined ? opts.mailer : opts.approvalMode ? null : capture;
    const logStream = new Writable({
      write(chunk, _enc, cb) {
        env.logs.push(String(chunk));
        cb();
      },
    });
    const deps: AppDeps = { clock: env.clock, resolveHost: opts.resolveHost ?? fakeResolver(['intranet.example.com']), mailer, logStream, fetch: env.webhook.fetch };
    const built = await buildApp(testConfig(env.dbUrl, opts.config), deps);
    env.app = built.app;
    env.internal = built.internal;
    env.ctx = built.ctx;
    return env;
  }

  async close() {
    await this.internal.close();
    await this.app.close();
    await this.dropDb?.();
  }

  async req(method: string, url: string, o: ReqOpts = {}): Promise<Res> {
    const headers: Record<string, string> = { origin: BASE_URL, ...(o.headers ?? {}) };
    if (o.cookie) headers.cookie = o.cookie;
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`;
    const r = await this.app.inject({
      method: method as 'GET',
      url,
      headers,
      ...(o.body !== undefined ? { payload: o.body as object } : {}),
    });
    this.responses.push(`${method} ${url} ${r.statusCode}\n${JSON.stringify(r.headers)}\n${r.body}`);
    let body: unknown = null;
    try {
      body = r.body ? JSON.parse(r.body) : null;
    } catch {
      body = r.body;
    }
    return { status: r.statusCode, body, headers: r.headers as Res['headers'], text: r.body };
  }

  /** Internal runner API request (runner token unless `token` is given; null = no token). */
  async ireq(method: string, url: string, o: { body?: unknown; token?: string | null; headers?: Record<string, string>; payload?: Buffer } = {}): Promise<Res> {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    const token = o.token === undefined ? TEST_RUNNER_TOKEN : o.token;
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await this.internal.inject({
      method: method as 'GET',
      url,
      headers,
      ...(o.payload !== undefined ? { payload: o.payload } : o.body !== undefined ? { payload: o.body as object } : {}),
    });
    this.responses.push(`INTERNAL ${method} ${url} ${r.statusCode}\n${r.body}`);
    let body: unknown = null;
    try {
      body = r.body ? JSON.parse(r.body) : null;
    } catch {
      body = r.body;
    }
    return { status: r.statusCode, body, headers: r.headers as Res['headers'], text: r.body };
  }

  /** Listen on ephemeral ports (for a real runner). Returns base URLs. */
  async listen(): Promise<{ publicUrl: string; internalUrl: string }> {
    const publicUrl = await this.app.listen({ host: '127.0.0.1', port: 0 });
    const internalUrl = await this.internal.listen({ host: '127.0.0.1', port: 0 });
    return { publicUrl, internalUrl };
  }

  // ── auth helpers
  async signUp(email: string, password = PASSWORD, name = email.split('@')[0]!) {
    return this.req('POST', '/api/auth/sign-up/email', { body: { email, password, name } });
  }

  lastMailTo(email: string): MailMessage | undefined {
    return [...this.mails].reverse().find((m) => m.to === email);
  }

  async verifyFromMail(email: string) {
    const mail = this.lastMailTo(email);
    if (!mail) throw new Error(`no mail to ${email}`);
    const link = /https?:\/\/\S+/.exec(mail.text)?.[0];
    if (!link) throw new Error('no link in mail');
    const u = new URL(link);
    return this.req('GET', u.pathname + u.search);
  }

  async signIn(email: string, password = PASSWORD): Promise<{ res: Res; cookie: string | null }> {
    const res = await this.req('POST', '/api/auth/sign-in/email', { body: { email, password } });
    return { res, cookie: cookieFrom(res) };
  }

  /** Sign up (+ verify / approve) and sign in. */
  async user(email: string): Promise<{ id: string; email: string; cookie: string }> {
    const up = await this.signUp(email);
    if (up.status !== 200) throw new Error(`sign-up failed ${up.status} ${up.text}`);
    if (this.ctx.approvalMode) {
      const admin = await this.adminCookie();
      if (email !== 'admin@example.com') await this.req('POST', `/api/admin/users/${up.body.user.id}/approve`, { cookie: admin });
    } else {
      const v = await this.verifyFromMail(email);
      if (v.status >= 400) throw new Error(`verify failed ${v.status} ${v.text}`);
    }
    const { res, cookie } = await this.signIn(email);
    if (!cookie) throw new Error(`sign-in failed ${res.status} ${res.text}`);
    return { id: up.body.user.id, email, cookie };
  }

  private adminCookieCache: string | null = null;
  async adminCookie(): Promise<string> {
    if (this.adminCookieCache) return this.adminCookieCache;
    const email = 'admin@example.com';
    const up = await this.signUp(email);
    if (up.status !== 200) throw new Error(`admin sign-up failed ${up.text}`);
    if (!this.ctx.approvalMode) await this.verifyFromMail(email);
    const { cookie, res } = await this.signIn(email);
    if (!cookie) throw new Error(`admin sign-in failed ${res.text}`);
    this.adminCookieCache = cookie;
    return cookie;
  }
}

export function cookieFrom(res: Res): string | null {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const pairs = list.map((c) => c.split(';')[0]!).filter((p) => /session_token=./.test(p));
  return pairs.length ? pairs.join('; ') : null;
}

/** Every row of every table in the public schema, as text — a data dump to scan for plaintext. */
export async function dumpDatabase(url: string): Promise<string> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const tables = await c.query<{ table_name: string }>(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`);
  const out: string[] = [];
  for (const t of tables.rows) {
    const rows = await c.query(`select t::text as row from "${t.table_name}" t`);
    out.push(`-- ${t.table_name}`, ...rows.rows.map((r: { row: string }) => r.row));
  }
  await c.end();
  return out.join('\n');
}
