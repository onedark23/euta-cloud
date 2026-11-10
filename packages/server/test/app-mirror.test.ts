// GitHub release mirror (ADR-048 decision 2): a fake github.com (global fetch stub) serves the
// `releases/latest` redirect and release files; the server imports a new version (files · blockmaps ·
// ymls, sha512 checked), skips one it has, removes the draft on failure, skips a missing platform,
// runs one sync at a time, is off without APP_MIRROR_GITHUB, and only administrators may sync now.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { appReleases, users } from '../src/db/schema.js';
import { notesText, STALE_DRAFT_MS, tagFromLocation } from '../src/services/app-mirror.js';
import { TestEnv } from './helpers.js';

const GH = 'https://github.com';
const REPO = 'example/euta-app';
const MIRROR = { repo: REPO, intervalMs: 600_000, baseUrl: GH };
const sha512 = (b: Buffer) => createHash('sha512').update(b).digest('base64');

/** What the fake GitHub serves: the latest tag and that tag's files. */
const gh = { tag: null as string | null, files: new Map<string, Buffer>(), requests: [] as string[] };

function publishOnGitHub(version: string, o: { platforms?: ('mac' | 'win' | 'linux')[]; badSha?: string; notes?: unknown; ymlVersion?: Partial<Record<string, string>> } = {}) {
  gh.tag = `app-v${version}`;
  gh.files = new Map();
  const platforms = o.platforms ?? ['mac', 'win', 'linux'];
  const add = (name: string) => {
    const b = Buffer.from(`fake ${name} `.repeat(500));
    gh.files.set(name, b);
    return b;
  };
  const yml = (name: string, files: string[], blockmaps: string[]) => {
    const entries = files.map((f) => {
      const b = add(f);
      return `  - url: ${f}\n    sha512: ${f === o.badSha ? sha512(Buffer.from('other')) : sha512(b)}\n    size: ${b.length}`;
    });
    for (const f of blockmaps) add(`${f}.blockmap`);
    const notes = o.notes === undefined ? `releaseNotes: "- ${version} notes"\n` : `releaseNotes: ${JSON.stringify(o.notes)}\n`;
    gh.files.set(name, Buffer.from(`version: ${o.ymlVersion?.[name] ?? version}\nfiles:\n${entries.join('\n')}\npath: ${files[0]}\n${notes}releaseDate: '2026-11-10T00:00:00.000Z'\n`));
  };
  const zip = `euta-${version}-mac-arm64.zip`;
  const dmg = `euta-${version}-mac-arm64.dmg`;
  const exe = `euta-${version}-win-x64.exe`;
  const appImage = `euta-${version}-linux-x86_64.AppImage`;
  // dmg has no blockmap on GitHub → skipped.
  if (platforms.includes('mac')) yml('latest-mac.yml', [zip, dmg], [zip]);
  if (platforms.includes('win')) yml('latest.yml', [exe], [exe]);
  if (platforms.includes('linux')) yml('latest-linux.yml', [appImage], [appImage]);
  return { zip, dmg, exe, appImage };
}

function fakeGitHub(url: string, init?: RequestInit): Response {
  gh.requests.push(url);
  if (url === `${GH}/${REPO}/releases/latest`) {
    expect(init?.redirect).toBe('manual');
    return new Response(null, { status: 302, headers: { location: gh.tag ? `${GH}/${REPO}/releases/tag/${gh.tag}` : `${GH}/${REPO}/releases` } });
  }
  const m = new RegExp(`^${GH}/${REPO}/releases/download/([^/]+)/([^/]+)$`).exec(url);
  const body = m && decodeURIComponent(m[1]!) === gh.tag ? gh.files.get(m[2]!) : undefined;
  if (!body) return new Response('Not Found', { status: 404 });
  return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } });
}

describe('mirror helpers and config', () => {
  it('reads the tag from the releases/latest redirect', () => {
    expect(tagFromLocation(`${GH}/${REPO}/releases/tag/app-v0.1.0-alpha.2`, GH)).toBe('app-v0.1.0-alpha.2');
    expect(tagFromLocation(`/${REPO}/releases/tag/app-v1.0.0`, GH)).toBe('app-v1.0.0');
    expect(tagFromLocation(`${GH}/${REPO}/releases`, GH)).toBeNull();
    expect(() => tagFromLocation(`${GH}/${REPO}/releases/tag/a%20b`, GH)).toThrow(/tag/);
  });

  it('turns release notes into text like the app', () => {
    expect(notesText(' 고침 ')).toBe('고침');
    expect(notesText([{ version: '1', note: 'a' }, { version: '0', note: 'b' }])).toBe('a\n\nb');
    expect(notesText(null)).toBeUndefined();
  });

  it('APP_MIRROR_GITHUB: empty = off, owner/repo only; interval is a duration (default 10m)', () => {
    const base = {
      DATABASE_URL: 'postgres://x@localhost/x',
      BETTER_AUTH_SECRET: 's'.repeat(40),
      CREDENTIALS_KEY: Buffer.alloc(32, 1).toString('base64'),
      ALLOWED_EMAIL_DOMAINS: 'example.com',
      SMTP_URL: 'smtp://m',
    };
    expect(loadConfig(base).appMirror).toBeNull();
    expect(loadConfig({ ...base, APP_MIRROR_GITHUB: ' ' }).appMirror).toBeNull();
    expect(loadConfig({ ...base, APP_MIRROR_GITHUB: REPO }).appMirror).toEqual({ repo: REPO, intervalMs: 600_000, baseUrl: GH });
    expect(loadConfig({ ...base, APP_MIRROR_GITHUB: REPO, APP_MIRROR_INTERVAL: '1h', APP_MIRROR_BASE_URL: 'http://127.0.0.1:9/' }).appMirror).toEqual({
      repo: REPO,
      intervalMs: 3_600_000,
      baseUrl: 'http://127.0.0.1:9',
    });
    for (const bad of ['euta-app', 'https://github.com/example/euta-app', 'a/b/c', 'example/', '/euta-app', 'ex ample/euta-app', 'example/..']) {
      expect(() => loadConfig({ ...base, APP_MIRROR_GITHUB: bad }), bad).toThrow(/APP_MIRROR_GITHUB/);
    }
    for (const bad of ['10', 'ten minutes', '30s']) expect(() => loadConfig({ ...base, APP_MIRROR_GITHUB: REPO, APP_MIRROR_INTERVAL: bad }), bad).toThrow(/APP_MIRROR_INTERVAL/);
  });
});

describe('mirror off', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await TestEnv.create();
  });
  afterAll(async () => env?.close());

  it('has no mirror status and refuses sync now', async () => {
    const cookie = await env.adminCookie();
    const list = await env.req('GET', '/api/admin/app-releases', { cookie });
    expect(list.status).toBe(200);
    expect(list.body.mirror).toBeNull();
    const r = await env.req('POST', '/api/admin/app-releases/mirror', { cookie });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('MIRROR_OFF');
  });
});

describe('GitHub release mirror', () => {
  let env: TestEnv;
  let admin: string;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.startsWith(`${GH}/`)) return realFetch(input, init);
      return fakeGitHub(url, init);
    });
    env = await TestEnv.create({ config: { appMirror: MIRROR } });
    admin = await env.adminCookie();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await env?.close();
  });

  const sync = async () => {
    const r = await env.req('POST', '/api/admin/app-releases/mirror', { cookie: admin });
    expect(r.status).toBe(200);
    return r.body;
  };
  const releases = async () => (await env.req('GET', '/api/admin/app-releases', { cookie: admin })).body;

  it('only administrators may sync now', async () => {
    expect((await env.req('POST', '/api/admin/app-releases/mirror')).status).toBe(401);
    const member = await env.user('member@example.com');
    const r = await env.req('POST', '/api/admin/app-releases/mirror', { cookie: member.cookie });
    expect(r.status).toBe(403);
    expect((await env.req('GET', '/api/admin/app-releases', { cookie: member.cookie })).status).toBe(403);
  });

  it('no release on GitHub yet → none; the status is in the admin list', async () => {
    expect((await releases()).mirror).toEqual({ repo: REPO, running: false, lastRun: null });
    const s = await sync();
    expect(s).toMatchObject({ repo: REPO, running: false, lastRun: { result: 'none' } });
    expect((await releases()).mirror.lastRun.result).toBe('none');
  });

  it('imports a new version: files · blockmaps · ymls (sha512 checked), notes, then publishes', async () => {
    const f = publishOnGitHub('0.1.0-alpha.1', { notes: [{ version: '0.1.0-alpha.1', note: '첫 알파' }] });
    const before = env.clock.now().getTime();
    const s = await sync();
    expect(s.lastRun).toMatchObject({ result: 'published', version: '0.1.0-alpha.1' });
    expect(Date.parse(s.lastRun.at)).toBeGreaterThanOrEqual(before);
    const [rel] = (await releases()).releases;
    expect(rel).toMatchObject({ version: '0.1.0-alpha.1', channel: 'alpha', status: 'published', notes: '첫 알파' });
    const names = (rel.files as { name: string; sha512: string }[]).map((x) => x.name).sort();
    expect(names).toEqual(
      [f.zip, `${f.zip}.blockmap`, f.dmg, f.exe, `${f.exe}.blockmap`, f.appImage, `${f.appImage}.blockmap`, 'latest-mac.yml', 'latest.yml', 'latest-linux.yml'].sort(),
    );
    for (const x of rel.files as { name: string; sha512: string }[]) expect(x.sha512).toBe(sha512(gh.files.get(x.name)!));
    // Everything came from the tag, not from releases/latest/download.
    expect(gh.requests.filter((u) => u.includes('/releases/download/')).every((u) => u.includes('/releases/download/app-v0.1.0-alpha.1/'))).toBe(true);
    const yml = await env.app.inject({ method: 'GET', url: '/updates/alpha/latest-linux.yml' });
    expect(yml.statusCode).toBe(200);
    expect(yml.body).toBe(gh.files.get('latest-linux.yml')!.toString());
    const exe = await env.app.inject({ method: 'GET', url: `/updates/alpha/${f.exe}` });
    expect(exe.rawPayload.equals(gh.files.get(f.exe)!)).toBe(true);
  });

  it('a version the server already has is left alone (no file downloads)', async () => {
    gh.requests = [];
    const s = await sync();
    expect(s.lastRun).toMatchObject({ result: 'already', version: '0.1.0-alpha.1' });
    expect(gh.requests.filter((u) => !u.endsWith('.yml') && !u.endsWith('/releases/latest'))).toEqual([]);
    expect((await releases()).releases).toHaveLength(1);
  });

  it('sha512 that differs from the yml fails the run and leaves no draft', async () => {
    const f = publishOnGitHub('0.1.0-alpha.2', { badSha: 'euta-0.1.0-alpha.2-win-x64.exe' });
    const s = await sync();
    expect(s.lastRun).toMatchObject({ result: 'error' });
    expect(s.lastRun.message).toContain(`${f.exe}: sha512 differs from latest.yml`);
    expect((await releases()).releases.map((r: { version: string }) => r.version)).toEqual(['0.1.0-alpha.1']);
    expect(existsSync(join(env.ctx.config.updatesDir, 'alpha', '0.1.0-alpha.2'))).toBe(false);
    // Fixed on GitHub → the next run imports it.
    publishOnGitHub('0.1.0-alpha.2');
    expect((await sync()).lastRun).toMatchObject({ result: 'published', version: '0.1.0-alpha.2' });
  });

  it('a platform without its yml is skipped; the previous release keeps serving it', async () => {
    const f = publishOnGitHub('0.1.0-alpha.3', { platforms: ['mac', 'win'] });
    expect((await sync()).lastRun).toMatchObject({ result: 'published', version: '0.1.0-alpha.3' });
    const rel = (await releases()).releases.find((r: { version: string }) => r.version === '0.1.0-alpha.3');
    const names = (rel.files as { name: string }[]).map((x) => x.name);
    expect(names).toContain('latest-mac.yml');
    expect(names).toContain(f.exe);
    expect(names.some((n) => n.includes('linux'))).toBe(false);
    expect((await env.app.inject({ method: 'GET', url: '/updates/alpha/latest-linux.yml' })).body).toContain('version: 0.1.0-alpha.2');
    expect((await env.app.inject({ method: 'GET', url: '/updates/alpha/latest.yml' })).body).toContain('version: 0.1.0-alpha.3');
  });

  it('ymls that disagree on the version fail; a missing file fails and removes the draft', async () => {
    publishOnGitHub('0.1.0-alpha.4', { ymlVersion: { 'latest.yml': '0.1.0-alpha.9' } });
    let s = await sync();
    expect(s.lastRun.result).toBe('error');
    expect(s.lastRun.message).toMatch(/0\.1\.0-alpha\.9/);
    const f = publishOnGitHub('0.1.0-alpha.4');
    gh.files.delete(f.appImage);
    s = await sync();
    expect(s.lastRun.result).toBe('error');
    expect(s.lastRun.message).toContain('HTTP 404');
    expect((await releases()).releases.some((r: { version: string }) => r.version === '0.1.0-alpha.4')).toBe(false);
  });

  it('never publishes an older version over a newer one', async () => {
    publishOnGitHub('0.1.0-alpha.0');
    const s = await sync();
    expect(s.lastRun).toMatchObject({ result: 'already', version: '0.1.0-alpha.0' });
    expect(s.lastRun.message).toContain('0.1.0-alpha.3');
  });

  it('one run at a time: a second trigger waits for the running one', async () => {
    publishOnGitHub('0.1.0-alpha.5');
    gh.requests = [];
    const [a, b] = await Promise.all([sync(), sync()]);
    expect(a.lastRun).toMatchObject({ result: 'published', version: '0.1.0-alpha.5' });
    expect(b.lastRun).toEqual(a.lastRun);
    expect(gh.requests.filter((u) => u.endsWith('/releases/latest'))).toHaveLength(1);
  });

  it('an interrupted import (mirror draft, created_by NULL) is cleared after a while; an admin draft never is', async () => {
    // A pod restart in the middle of an import leaves the mirror's own draft behind.
    publishOnGitHub('0.1.0-alpha.6');
    await env.ctx.db.insert(appReleases).values({ version: '0.1.0-alpha.6', channel: 'alpha', createdBy: null });
    let s = await sync();
    expect(s.lastRun).toMatchObject({ result: 'already', version: '0.1.0-alpha.6' }); // fresh: maybe another instance
    env.clock.advance(STALE_DRAFT_MS + 60_000);
    s = await sync();
    expect(s.lastRun).toMatchObject({ result: 'published', version: '0.1.0-alpha.6' });
    // A draft an administrator is uploading by hand stays, however old.
    publishOnGitHub('0.1.0-alpha.7');
    const [adm] = await env.ctx.db.select({ id: users.id }).from(users).where(eq(users.email, 'admin@example.com'));
    await env.ctx.db.insert(appReleases).values({ version: '0.1.0-alpha.7', channel: 'alpha', createdBy: adm!.id });
    env.clock.advance(STALE_DRAFT_MS + 60_000);
    expect((await sync()).lastRun).toMatchObject({ result: 'already', version: '0.1.0-alpha.7' });
    expect((await releases()).releases.find((r: { version: string }) => r.version === '0.1.0-alpha.7').status).toBe('draft');
  });
});
