// App releases (stage 17, SPEC_앱-배포-업데이트): admin upload lifecycle (draft → files → publish),
// public /updates and /api/app/* routes, latest*.yml switching on publish, keep-3 retention per channel,
// and the minimum app version (426 APP_TOO_OLD) for app device tokens only.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appTooOld } from '../src/services/app-version.js';
import { channelOf, classifyFile, parseVersion } from '../src/services/app-releases.js';
import { BASE_URL, TEST_RUNNER_TOKEN, TestEnv } from './helpers.js';
import { issueToken, rawMcpPost } from './mcp-helpers.js';

const sha512 = (b: Buffer) => createHash('sha512').update(b).digest('base64');

async function put(env: TestEnv, token: string, version: string, name: string, data: Buffer | string, headers: Record<string, string> = {}) {
  const r = await env.app.inject({
    method: 'PUT',
    url: `/api/admin/app-releases/${version}/files/${name}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', ...headers },
    payload: typeof data === 'string' ? Buffer.from(data) : data,
  });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
}

const yml = (version: string, file: string) => `version: ${version}\nfiles:\n  - url: ${file}\n    sha512: x\npath: ${file}\n`;

/** Create, upload mac zip + dmg + latest-mac.yml (+ extra files), publish. */
async function release(env: TestEnv, token: string, version: string, extra: Record<string, string> = {}) {
  expect((await env.req('POST', '/api/admin/app-releases', { bearer: token, body: { version, notes: `notes ${version}` } })).status).toBe(201);
  const zip = `euta-${version}-mac-arm64.zip`;
  const files: Record<string, string> = { [zip]: `zip ${version}`, [`euta-${version}-mac-arm64.dmg`]: `dmg ${version}`, 'latest-mac.yml': yml(version, zip), ...extra };
  for (const [name, data] of Object.entries(files)) expect((await put(env, token, version, name, data)).status).toBe(201);
  const pub = await env.req('POST', `/api/admin/app-releases/${version}/publish`, { bearer: token });
  expect(pub.status).toBe(200);
  return pub.body;
}

async function deviceToken(env: TestEnv, cookie: string): Promise<string> {
  const code = await env.req('POST', '/api/auth/device/code', { body: { client_id: 'euta-app' } });
  await env.req('GET', `/api/auth/device?user_code=${code.body.user_code}`, { cookie });
  expect((await env.req('POST', '/api/auth/device/approve', { cookie, body: { userCode: code.body.user_code } })).status).toBe(200);
  const tok = await env.req('POST', '/api/auth/device/token', {
    body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.body.device_code, client_id: 'euta-app' },
  });
  expect(tok.status).toBe(200);
  return tok.body.access_token as string;
}

describe('release names and versions', () => {
  it('parses SemVer with a channel, rejects build metadata and odd forms', () => {
    expect(parseVersion('0.1.0-alpha.1')).toBe('0.1.0-alpha.1');
    expect(parseVersion('1.2.3')).toBe('1.2.3');
    for (const bad of ['v1.0.0', '1.0', '1.0.0+build.1', '0.1.0-1', '', '../1.0.0', 7]) expect(parseVersion(bad)).toBeNull();
    expect(channelOf('0.1.0-alpha.3')).toBe('alpha');
    expect(channelOf('0.2.0-beta.1')).toBe('beta');
    expect(channelOf('1.0.0')).toBe('stable');
  });

  it('classifies electron-builder artifacts by name', () => {
    expect(classifyFile('euta-0.1.0-alpha.1-mac-arm64.dmg')).toEqual({ platform: 'mac', arch: 'arm64', kind: 'installer' });
    expect(classifyFile('euta-0.1.0-alpha.1-mac-x64.zip')).toEqual({ platform: 'mac', arch: 'x64', kind: 'update' });
    expect(classifyFile('euta-0.1.0-alpha.1-mac-x64.zip.blockmap')).toEqual({ platform: 'mac', arch: 'x64', kind: 'update' });
    expect(classifyFile('euta-0.1.0-alpha.1-win-x64.exe')).toEqual({ platform: 'win', arch: 'x64', kind: 'installer' });
    expect(classifyFile('euta-0.1.0-alpha.1-win-x64.exe.blockmap')).toEqual({ platform: 'win', arch: 'x64', kind: 'update' });
    expect(classifyFile('euta-0.1.0-alpha.1-linux-x86_64.AppImage')).toEqual({ platform: 'linux', arch: 'x64', kind: 'installer' });
    expect(classifyFile('latest-mac.yml')).toEqual({ platform: 'mac', arch: null, kind: 'meta' });
    expect(classifyFile('latest-linux.yml')).toEqual({ platform: 'linux', arch: null, kind: 'meta' });
    expect(classifyFile('latest.yml')).toEqual({ platform: 'win', arch: null, kind: 'meta' });
    for (const bad of ['euta Setup.exe', 'notes.txt', '.hidden.yml', '../x.zip', 'zip', 'a/b.zip']) expect(classifyFile(bad)).toBeNull();
  });

  it('compares app versions with prereleases', () => {
    expect(appTooOld('0.1.0-alpha.10', '0.1.0-alpha.2')).toBe(true);
    expect(appTooOld('0.1.0-alpha.2', '0.1.0-alpha.10')).toBe(false);
    expect(appTooOld('0.1.0', '0.1.0-alpha.10')).toBe(true);
    expect(appTooOld('0.1.0-alpha.10', '0.1.0')).toBe(false);
    expect(appTooOld('0.1.0-alpha.2', '0.1.0-alpha.2')).toBe(false);
    expect(appTooOld('0.1.0', undefined)).toBe(true);
    expect(appTooOld('0.1.0', 'not-a-version')).toBe(true);
  });
});

describe('app release upload and update files', () => {
  let env: TestEnv;
  let admin: string;
  let adminRead: string;
  let user: { cookie: string };

  beforeAll(async () => {
    env = await TestEnv.create();
    const cookie = await env.adminCookie();
    admin = (await issueToken(env, cookie, 'release', 'read_write')).token;
    adminRead = (await issueToken(env, cookie, 'release-ro', 'read')).token;
    user = await env.user('member@example.com');
  });
  afterAll(async () => env?.close());

  it('only administrators (session or read_write token) may manage releases', async () => {
    const body = { version: '0.0.1-alpha.1' };
    expect((await env.req('POST', '/api/admin/app-releases', { body })).status).toBe(401);
    expect((await env.req('POST', '/api/admin/app-releases', { cookie: user.cookie, body })).status).toBe(403);
    const userToken = (await issueToken(env, user.cookie, 'mine', 'read_write')).token;
    expect((await env.req('POST', '/api/admin/app-releases', { bearer: userToken, body })).status).toBe(403);
    expect((await env.req('POST', '/api/admin/app-releases', { bearer: adminRead, body })).status).toBe(403);
    expect((await env.req('GET', '/api/admin/app-releases', { cookie: user.cookie })).status).toBe(403);
    // An admin web session works too (web admin screen: publish / delete).
    const viaSession = await env.req('POST', '/api/admin/app-releases', { cookie: await env.adminCookie(), body });
    expect(viaSession.status).toBe(201);
    expect((await env.req('DELETE', '/api/admin/app-releases/0.0.1-alpha.1', { cookie: await env.adminCookie() })).status).toBe(200);
  });

  it('draft → files → publish, with version and file name checks', async () => {
    const c = await env.req('POST', '/api/admin/app-releases', { bearer: admin, body: { version: '0.1.0-alpha.1', notes: '첫 알파' } });
    expect(c.status).toBe(201);
    expect(c.body).toEqual({ version: '0.1.0-alpha.1', channel: 'alpha', status: 'draft' });
    const again = await env.req('POST', '/api/admin/app-releases', { bearer: admin, body: { version: '0.1.0-alpha.1' } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('VERSION_EXISTS');
    for (const version of ['v0.1.0', '0.1', '0.1.0+b1', undefined]) {
      const r = await env.req('POST', '/api/admin/app-releases', { bearer: admin, body: { version } });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_VERSION');
    }

    const zip = Buffer.from('PK fake mac update zip');
    const up = await put(env, admin, '0.1.0-alpha.1', 'euta-0.1.0-alpha.1-mac-arm64.zip', zip);
    expect(up.status).toBe(201);
    expect(up.body).toEqual({ name: 'euta-0.1.0-alpha.1-mac-arm64.zip', size: zip.length, sha512: sha512(zip) });
    // A retry of the same name replaces the file.
    const zip2 = Buffer.from('PK fake mac update zip, second try');
    expect((await put(env, admin, '0.1.0-alpha.1', 'euta-0.1.0-alpha.1-mac-arm64.zip', zip2)).body.sha512).toBe(sha512(zip2));

    for (const bad of ['euta%20Setup.exe', 'notes.txt', '.hidden.yml']) {
      const r = await put(env, admin, '0.1.0-alpha.1', bad, 'x');
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('UNSUPPORTED_FILE');
    }
    expect((await put(env, admin, '9.9.9-alpha.1', 'latest.yml', 'x')).status).toBe(404);
    expect((await put(env, adminRead, '0.1.0-alpha.1', 'latest.yml', 'x')).status).toBe(403);
    expect((await put(env, admin, '0.1.0-alpha.1', 'latest.yml', 'x', { 'content-type': 'text/plain' })).status).toBe(415);
    const big = await put(env, admin, '0.1.0-alpha.1', 'euta-big-win-x64.exe', 'x', { 'content-length': String(1024 ** 3 + 1) });
    expect(big.status).toBe(413);

    const noMeta = await env.req('POST', '/api/admin/app-releases/0.1.0-alpha.1/publish', { bearer: admin });
    expect(noMeta.status).toBe(400);
    expect(noMeta.body.error.code).toBe('NO_UPDATE_META');
    // Not public while a draft.
    expect((await env.req('GET', '/updates/alpha/euta-0.1.0-alpha.1-mac-arm64.zip')).status).toBe(404);
    // ADR-047: a server with only drafts does not distribute updates — connected apps keep using GitHub.
    expect((await env.req('GET', '/api/config')).body.appUpdates).toBe(false);

    expect((await put(env, admin, '0.1.0-alpha.1', 'latest-mac.yml', yml('0.1.0-alpha.1', 'euta-0.1.0-alpha.1-mac-arm64.zip'))).status).toBe(201);
    const pub = await env.req('POST', '/api/admin/app-releases/0.1.0-alpha.1/publish', { bearer: admin });
    expect(pub.status).toBe(200);
    expect(pub.body.version).toBe('0.1.0-alpha.1');
    expect(Date.parse(pub.body.publishedAt)).not.toBeNaN();
    expect((await env.req('GET', '/api/config')).body.appUpdates).toBe(true);

    const late = await put(env, admin, '0.1.0-alpha.1', 'latest.yml', 'x');
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('NOT_DRAFT');
    expect((await env.req('DELETE', '/api/admin/app-releases/0.1.0-alpha.1', { bearer: admin })).status).toBe(409);
    expect((await env.req('POST', '/api/admin/app-releases/0.1.0-alpha.1/publish', { bearer: admin })).status).toBe(409);

    // Served publicly, with no-store on the update info and Range on the files.
    const meta = await env.req('GET', '/updates/alpha/latest-mac.yml');
    expect(meta.status).toBe(200);
    expect(meta.headers['content-type']).toMatch(/^text\/yaml/);
    expect(meta.headers['cache-control']).toBe('no-store');
    expect(meta.text).toContain('version: 0.1.0-alpha.1');
    const file = await env.req('GET', '/updates/alpha/euta-0.1.0-alpha.1-mac-arm64.zip');
    expect(file.status).toBe(200);
    expect(file.text).toBe(zip2.toString());
    expect(file.headers['content-type']).toBe('application/zip');
    expect(file.headers['accept-ranges']).toBe('bytes');
    const part = await env.req('GET', '/updates/alpha/euta-0.1.0-alpha.1-mac-arm64.zip', { headers: { range: 'bytes=0-6' } });
    expect(part.status).toBe(206);
    expect(part.text).toBe('PK fake');
    expect(part.headers['content-range']).toBe(`bytes 0-6/${zip2.length}`);
    expect((await env.req('GET', '/updates/alpha/0.1.0-alpha.1/euta-0.1.0-alpha.1-mac-arm64.zip')).text).toBe(zip2.toString());
    // Misses are JSON 404s, never the web app's index.html.
    for (const miss of ['/updates/alpha/latest.yml', '/updates/beta/latest-mac.yml', '/updates/alpha/9.9.9/latest-mac.yml', '/updates/alpha', '/updates/alpha/x/y/z']) {
      const r = await env.req('GET', miss);
      expect(r.status, miss).toBe(404);
      expect(r.headers['content-type']).toMatch(/json/);
    }
  });

  it('publish switches latest*.yml; a file missing from the new version comes from the previous one', async () => {
    await release(env, admin, '0.1.0-alpha.2', { 'latest-linux.yml': yml('0.1.0-alpha.2', 'euta-0.1.0-alpha.2-linux-x86_64.AppImage'), 'euta-0.1.0-alpha.2-linux-x86_64.AppImage': 'appimage 2' });
    await release(env, admin, '0.1.0-alpha.3');
    expect((await env.req('GET', '/updates/alpha/latest-mac.yml')).text).toContain('version: 0.1.0-alpha.3');
    expect((await env.req('GET', '/updates/alpha/latest-linux.yml')).text).toContain('version: 0.1.0-alpha.2');
    expect((await env.req('GET', '/updates/alpha/euta-0.1.0-alpha.2-linux-x86_64.AppImage')).text).toBe('appimage 2');

    const list = await env.req('GET', '/api/app/releases?channel=alpha');
    expect(list.status).toBe(200);
    expect(list.body.channel).toBe('alpha');
    expect(list.body.releases.map((r: { version: string }) => r.version)).toEqual(['0.1.0-alpha.3', '0.1.0-alpha.2', '0.1.0-alpha.1']);
    const r3 = list.body.releases[0];
    expect(r3.notes).toBe('notes 0.1.0-alpha.3');
    expect(Date.parse(r3.publishedAt)).not.toBeNaN();
    expect(r3.files).toContainEqual({
      platform: 'mac',
      arch: 'arm64',
      kind: 'installer',
      name: 'euta-0.1.0-alpha.3-mac-arm64.dmg',
      size: 'dmg 0.1.0-alpha.3'.length,
      url: `${BASE_URL}/updates/alpha/0.1.0-alpha.3/euta-0.1.0-alpha.3-mac-arm64.dmg`,
    });
    expect(r3.files).toContainEqual(expect.objectContaining({ name: 'latest-mac.yml', platform: 'mac', arch: null, kind: 'meta' }));
    expect((await env.req('GET', '/api/app/releases?channel=beta')).body).toEqual({ channel: 'beta', releases: [] });
    expect((await env.req('GET', '/api/app/releases?channel=../x')).status).toBe(400);
    expect((await env.req('GET', '/api/app/compat')).body).toEqual({ minVersion: null });
  });

  it('keeps the newest 3 published per channel and deletes older files; drafts and other channels stay', async () => {
    await release(env, admin, '0.2.0-beta.1');
    expect((await env.req('POST', '/api/admin/app-releases', { bearer: admin, body: { version: '0.1.0-alpha.9' } })).status).toBe(201);
    expect((await put(env, admin, '0.1.0-alpha.9', 'latest-mac.yml', 'draft')).status).toBe(201);
    const dir1 = join(env.ctx.config.updatesDir, 'alpha', '0.1.0-alpha.1');
    expect(existsSync(dir1)).toBe(true);

    await release(env, admin, '0.1.0-alpha.4');
    expect(existsSync(dir1)).toBe(false);
    expect(existsSync(join(env.ctx.config.updatesDir, 'alpha', '0.1.0-alpha.2'))).toBe(true);
    expect(existsSync(join(env.ctx.config.updatesDir, 'alpha', '0.1.0-alpha.9', 'latest-mac.yml'))).toBe(true);
    expect(existsSync(join(env.ctx.config.updatesDir, 'beta', '0.2.0-beta.1'))).toBe(true);
    const list = await env.req('GET', '/api/app/releases?channel=alpha');
    expect(list.body.releases.map((r: { version: string }) => r.version)).toEqual(['0.1.0-alpha.4', '0.1.0-alpha.3', '0.1.0-alpha.2']);
    expect((await env.req('GET', '/updates/alpha/0.1.0-alpha.1/euta-0.1.0-alpha.1-mac-arm64.zip')).status).toBe(404);
    expect((await env.req('GET', '/updates/beta/latest-mac.yml')).text).toContain('0.2.0-beta.1');

    const all = await env.req('GET', '/api/admin/app-releases', { bearer: admin });
    expect(all.status).toBe(200);
    expect(all.body.releases.map((r: { version: string; status: string }) => `${r.version}:${r.status}`)).toEqual([
      '0.1.0-alpha.4:published',
      '0.1.0-alpha.9:draft',
      '0.2.0-beta.1:published',
      '0.1.0-alpha.3:published',
      '0.1.0-alpha.2:published',
    ]);
    // A deleted draft takes its folder with it; the version number is free again.
    expect((await env.req('DELETE', '/api/admin/app-releases/0.1.0-alpha.9', { bearer: admin })).status).toBe(200);
    expect(existsSync(join(env.ctx.config.updatesDir, 'alpha', '0.1.0-alpha.9'))).toBe(false);
    expect((await env.req('DELETE', '/api/admin/app-releases/0.1.0-alpha.9', { bearer: admin })).status).toBe(404);
  });
});

describe('minimum app version (426 APP_TOO_OLD)', () => {
  let env: TestEnv;
  let cookie: string;
  let device: string;
  let personal: string;
  let base: string;

  beforeAll(async () => {
    env = await TestEnv.create({ config: { minAppVersion: '0.1.0-alpha.5' } });
    const u = await env.user('app-user@example.com');
    cookie = u.cookie;
    device = await deviceToken(env, cookie);
    personal = (await issueToken(env, cookie, 'mcp', 'read_write')).token;
    base = await env.app.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => env?.close());

  const asApp = (version?: string): { bearer: string; headers: Record<string, string> } => ({
    bearer: device,
    headers: version === undefined ? {} : { 'x-euta-app-version': version },
  });

  it('rejects device-token requests without the header or below the minimum', async () => {
    for (const v of [undefined, '0.1.0-alpha.4', '0.1.0-alpha.1', 'garbage']) {
      const r = await env.req('GET', '/api/me', asApp(v));
      expect(r.status, String(v)).toBe(426);
      expect(r.body).toMatchObject({ code: 'APP_TOO_OLD', minVersion: '0.1.0-alpha.5', error: { code: 'APP_TOO_OLD' } });
    }
    for (const v of ['0.1.0-alpha.5', '0.1.0-alpha.10', '0.1.0', '0.2.0-alpha.1']) {
      expect((await env.req('GET', '/api/me', asApp(v))).status, v).toBe(200);
    }
    expect((await env.req('GET', '/api/projects', asApp('0.1.0-alpha.4'))).status).toBe(426);
  });

  it('does not check web sessions, personal tokens (MCP), runners, or the public app routes', async () => {
    expect((await env.req('GET', '/api/me', { cookie })).status).toBe(200);
    expect((await env.req('GET', '/api/me', { bearer: personal })).status).toBe(200);
    expect((await rawMcpPost(base, { authorization: `Bearer ${personal}` })).status).toBe(200);
    expect((await env.ireq('POST', '/internal/runner/claim', { token: TEST_RUNNER_TOKEN, body: { runnerId: 'r1', location: 'test', waitMs: 0 } })).status).not.toBe(426);
    // An old app can still find and download the new version, and see the minimum.
    expect((await env.req('GET', '/api/app/releases?channel=alpha', asApp('0.0.1-alpha.1'))).status).toBe(200);
    expect((await env.req('GET', '/api/app/compat', asApp())).body).toEqual({ minVersion: '0.1.0-alpha.5' });
    // …and still sign in / out (Better Auth routes).
    expect((await env.req('GET', '/api/auth/get-session', asApp())).status).toBe(200);
  });

  it('checks SSE at connect time', async () => {
    const old = await fetch(`${base}/api/me/events`, { headers: { authorization: `Bearer ${device}`, 'x-euta-app-version': '0.1.0-alpha.4' } });
    expect(old.status).toBe(426);
    expect(((await old.json()) as { code: string }).code).toBe('APP_TOO_OLD');
    const ac = new AbortController();
    const ok = await fetch(`${base}/api/me/events`, { headers: { authorization: `Bearer ${device}`, 'x-euta-app-version': '0.1.0-alpha.5' }, signal: ac.signal });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/text\/event-stream/);
    ac.abort();
  });
});

describe('minimum app version unset', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await TestEnv.create();
  });
  afterAll(async () => env?.close());

  it('lets every app version through', async () => {
    const u = await env.user('old-app@example.com');
    const device = await deviceToken(env, u.cookie);
    expect((await env.req('GET', '/api/me', { bearer: device })).status).toBe(200);
    expect((await env.req('GET', '/api/me', { bearer: device, headers: { 'x-euta-app-version': '0.0.1' } })).status).toBe(200);
  });
});
