// SPEC 스크립트: base-version conflict 409 · validation 422 vs external accepted · YAML parse always
// rejected · 256 KiB · path rules · versions (keep 200) · rename · delete/restore/purge · revert.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptHash } from '@euta/core';
import { DAY_MS } from '../src/clock.js';
import { scripts, scriptVersions } from '../src/db/schema.js';
import { purgeExpired } from '../src/services/purge.js';
import { INVALID_SCRIPT, TestEnv, VALID_SCRIPT } from './helpers.js';

describe('scripts', () => {
  let env: TestEnv;
  let a: { id: string; cookie: string };
  let b: { id: string; cookie: string };
  let pid: string;
  const url = (path: string, suffix = '') => `/api/projects/${pid}/scripts/${path}${suffix}`;

  beforeAll(async () => {
    env = await TestEnv.create();
    a = await env.user('alice@example.com');
    b = await env.user('bob@example.com');
    pid = (await env.req('POST', '/api/projects', { cookie: a.cookie, body: { name: 'S' } })).body.id;
    await env.req('PUT', `/api/projects/${pid}/members/${b.id}`, { cookie: a.cookie, body: { role: 'editor' } });
  });
  afterAll(async () => env?.close());

  it('creates version 1 with hash, author and origin; source kept verbatim (comments)', async () => {
    const src = `# 주석은 보존\n${VALID_SCRIPT}`;
    const r = await env.req('PUT', url('checkout/pay.yaml'), { cookie: a.cookie, body: { source: src, origin: 'app', memo: 'first' } });
    expect(r.status).toBe(201);
    expect(r.body.script).toMatchObject({ path: 'checkout/pay.yaml', version: 1, validationOk: true, contentHash: scriptHash(src), updatedBy: { id: a.id, name: 'alice' } });
    expect(r.body.version).toMatchObject({ version: 1, origin: 'app', memo: 'first' });
    const got = await env.req('GET', url('checkout/pay.yaml'), { cookie: b.cookie });
    expect(got.body.source).toBe(src);
    const list = await env.req('GET', `/api/projects/${pid}/scripts`, { cookie: b.cookie });
    expect(list.body.scripts.map((s: { path: string }) => s.path)).toContain('checkout/pay.yaml');
  });

  it('save requires the current base version; mismatch → 409 with current version info', async () => {
    await env.req('PUT', url('race.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } });
    const v2 = VALID_SCRIPT.replace('/dashboard', '/home');
    const bSave = await env.req('PUT', url('race.yaml'), { cookie: b.cookie, body: { source: v2, baseVersion: 1 } });
    expect(bSave.status).toBe(200);
    expect(bSave.body.script.version).toBe(2);
    // Alice still edits from v1 → conflict.
    const aSave = await env.req('PUT', url('race.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT.replace('/dashboard', '/a'), baseVersion: 1 } });
    expect(aSave.status).toBe(409);
    expect(aSave.body.error.code).toBe('SCRIPT_CONFLICT');
    expect(aSave.body.error.details.current).toMatchObject({ version: 2, source: v2, author: { id: b.id, name: 'bob' }, contentHash: scriptHash(v2) });
    // Missing base version on an existing script is a conflict too; creating with a base version as well.
    expect((await env.req('PUT', url('race.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } })).status).toBe(409);
    const ghost = await env.req('PUT', url('ghost.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT, baseVersion: 3 } });
    expect(ghost.status).toBe(409);
    expect(ghost.body.error.details.current).toBeNull();
    // Retrying from the current version works ("내 것으로 새 버전").
    const retry = await env.req('PUT', url('race.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT.replace('/dashboard', '/a'), baseVersion: 2 } });
    expect(retry.body.script.version).toBe(3);
  });

  it('concurrent saves from the same base: exactly one wins', async () => {
    await env.req('PUT', url('concurrent.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } });
    const results = await Promise.all(
      [1, 2, 3, 4].map((i) => env.req('PUT', url('concurrent.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT.replace('/dashboard', `/d${i}`), baseVersion: 1 } })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  });

  it('identical content does not create a version', async () => {
    await env.req('PUT', url('same.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } });
    const r = await env.req('PUT', url('same.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT, baseVersion: 1 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ unchanged: true, script: { version: 1 } });
  });

  it('invalid script → 422 with issues; origin external → stored and flagged', async () => {
    const r = await env.req('PUT', url('bad.yaml'), { cookie: a.cookie, body: { source: INVALID_SCRIPT } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('SCRIPT_INVALID');
    expect(r.body.error.details.issues.length).toBeGreaterThan(0);
    expect((await env.req('GET', url('bad.yaml'), { cookie: a.cookie })).status).toBe(404);

    const ext = await env.req('PUT', url('bad.yaml'), { cookie: a.cookie, body: { source: INVALID_SCRIPT, origin: 'external' } });
    expect(ext.status).toBe(201);
    expect(ext.body.script.validationOk).toBe(false);
    expect(ext.body.version.validation.ok).toBe(false);
    expect(ext.body.version.origin).toBe('external');
    const got = await env.req('GET', url('bad.yaml'), { cookie: a.cookie });
    expect(got.body.validation.issues.length).toBeGreaterThan(0);
  });

  it('YAML that does not parse is rejected even for external edits', async () => {
    for (const origin of ['web', 'external']) {
      const r = await env.req('PUT', url('broken.yaml'), { cookie: a.cookie, body: { source: 'steps: [unclosed', origin } });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('YAML_PARSE_ERROR');
    }
  });

  it('size limit 256 KiB', async () => {
    const pad = `\n# ${'x'.repeat(256 * 1024)}\n`;
    const r = await env.req('PUT', url('big.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT + pad } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('SCRIPT_TOO_LARGE');
  });

  it('path rules', async () => {
    for (const p of ['x.json', '.hidden.yaml', 'a/.b/c.yaml', 'a%5Cb.yaml']) {
      const r = await env.req('PUT', url(p), { cookie: a.cookie, body: { source: VALID_SCRIPT } });
      expect(r.status, p).toBe(422);
    }
    // Encoded traversal never reaches storage: URL resolution collapses "%2E%2E" segments before
    // routing (escaping the scripts route → 404, or a plain in-project path), "..%2F" hits the path rule.
    for (const p of ['%2E%2E/up.yaml', 'a/%2E%2E/b.yaml', '..%2Fup.yaml']) await env.req('PUT', url(p), { cookie: a.cookie, body: { source: VALID_SCRIPT } });
    expect((await env.req('PUT', url('..%2Fup.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } })).status).toBe(422);
    const stored = await env.ctx.db.select({ path: scripts.path }).from(scripts);
    expect(stored.some((x) => x.path.includes('..') || x.path.includes('\\'))).toBe(false);
    expect((await env.req('PUT', url('ok/nested/deep.yml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } })).status).toBe(201);
  });

  it('versions list / single version / revert creates a new version', async () => {
    await env.req('PUT', url('hist.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } });
    const v2src = VALID_SCRIPT.replace('/dashboard', '/v2');
    await env.req('PUT', url('hist.yaml'), { cookie: b.cookie, body: { source: v2src, baseVersion: 1 } });
    const list = await env.req('GET', url('hist.yaml', '/versions'), { cookie: a.cookie });
    expect(list.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(list.body.versions[0].source).toBeUndefined();
    expect((await env.req('GET', url('hist.yaml', '/versions/1'), { cookie: a.cookie })).body.source).toBe(VALID_SCRIPT);
    expect((await env.req('GET', url('hist.yaml', '/versions/9'), { cookie: a.cookie })).status).toBe(404);
    expect((await env.req('POST', url('hist.yaml', '/revert'), { cookie: a.cookie, body: { version: 1, baseVersion: 1 } })).status).toBe(409);
    const rev = await env.req('POST', url('hist.yaml', '/revert'), { cookie: a.cookie, body: { version: 1, baseVersion: 2 } });
    expect(rev.status).toBe(200);
    expect(rev.body.version).toMatchObject({ version: 3, origin: 'revert' });
    expect((await env.req('GET', url('hist.yaml'), { cookie: a.cookie })).body.source).toBe(VALID_SCRIPT);
    expect((await env.req('GET', url('hist.yaml', '/versions'), { cookie: a.cookie })).body.versions).toHaveLength(3);
  });

  it('keeps only the latest 200 versions per script', async () => {
    const r = await env.req('PUT', url('many.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } });
    const scriptId = r.body.script.id as string;
    for (let v = 2; v <= 201; v++) {
      const s = await env.req('PUT', url('many.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT.replace('/dashboard', `/v${v}`), baseVersion: v - 1 } });
      expect(s.status).toBe(200);
    }
    const rows = await env.ctx.db.select({ version: scriptVersions.version }).from(scriptVersions).where(eq(scriptVersions.scriptId, scriptId));
    expect(rows).toHaveLength(200);
    expect(Math.min(...rows.map((x) => x.version))).toBe(2);
    expect(Math.max(...rows.map((x) => x.version))).toBe(201);
  }, 120_000);

  it('rename keeps history; existing target path refused', async () => {
    await env.req('PUT', url('old.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } });
    await env.req('PUT', url('taken.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } });
    expect((await env.req('POST', url('old.yaml', '/rename'), { cookie: a.cookie, body: { newPath: 'taken.yaml' } })).status).toBe(409);
    expect((await env.req('POST', url('old.yaml', '/rename'), { cookie: a.cookie, body: { newPath: '../x.yaml' } })).status).toBe(422);
    const r = await env.req('POST', url('old.yaml', '/rename'), { cookie: a.cookie, body: { newPath: 'moved/new.yaml' } });
    expect(r.status).toBe(200);
    expect(r.body.path).toBe('moved/new.yaml');
    expect((await env.req('GET', url('old.yaml'), { cookie: a.cookie })).status).toBe(404);
    expect((await env.req('GET', url('moved/new.yaml', '/versions'), { cookie: a.cookie })).body.versions).toHaveLength(1);
  });

  it('delete → hidden → restore; path reuse blocks restore; purge after 30 days', async () => {
    await env.req('PUT', url('del.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } });
    expect((await env.req('DELETE', url('del.yaml'), { cookie: a.cookie })).status).toBe(204);
    expect((await env.req('GET', url('del.yaml'), { cookie: a.cookie })).status).toBe(404);
    const deleted = await env.req('GET', `/api/projects/${pid}/scripts?deleted=1`, { cookie: a.cookie });
    expect(deleted.body.scripts.map((s: { path: string }) => s.path)).toContain('del.yaml');
    const restored = await env.req('POST', url('del.yaml', '/restore'), { cookie: a.cookie });
    expect(restored.status).toBe(200);
    expect(restored.body.version).toBe(1);

    // A new script at the same path blocks restoring the deleted one.
    await env.req('DELETE', url('del.yaml'), { cookie: a.cookie });
    await env.req('PUT', url('del.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } });
    expect((await env.req('POST', url('del.yaml', '/restore'), { cookie: a.cookie })).status).toBe(409);

    await env.req('PUT', url('purge.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } });
    await env.req('DELETE', url('purge.yaml'), { cookie: a.cookie });
    env.clock.advance(31 * DAY_MS);
    expect((await env.req('POST', url('purge.yaml', '/restore'), { cookie: a.cookie })).status).toBe(404);
    await purgeExpired(env.ctx);
    const left = await env.ctx.db.select().from(scripts).where(eq(scripts.path, 'purge.yaml'));
    expect(left).toHaveLength(0);
    env.clock.offsetMs = 0;
  });

  it('activity records script changes with origin', async () => {
    for (const k of ['script.created', 'script.saved', 'script.renamed', 'script.deleted', 'script.restored', 'script.reverted']) {
      const act = await env.req('GET', `/api/projects/${pid}/activity?kind=${k}&limit=1`, { cookie: a.cookie });
      expect(act.body.entries[0]?.kind, k).toBe(k);
    }
    const prefix = await env.req('GET', `/api/projects/${pid}/activity?kind=script&limit=50`, { cookie: a.cookie });
    expect(prefix.body.entries.every((e: { kind: string }) => e.kind.startsWith('script.'))).toBe(true);
    const byBob = await env.req('GET', `/api/projects/${pid}/activity?actor=${b.id}`, { cookie: a.cookie });
    expect(byBob.body.entries.every((e: { actor: { id: string } }) => e.actor.id === b.id)).toBe(true);
    const page = await env.req('GET', `/api/projects/${pid}/activity?limit=2`, { cookie: a.cookie });
    const next = await env.req('GET', `/api/projects/${pid}/activity?limit=2&before=${page.body.nextBefore}`, { cookie: a.cookie });
    expect(next.body.entries[0].id).toBeLessThan(page.body.entries[1].id);
  });

  it('token saves are attributed to AI with the token name', async () => {
    const t = (await env.req('POST', '/api/me/tokens', { cookie: b.cookie, body: { name: 'my-claude', permission: 'read_write' } })).body.token;
    const r = await env.req('PUT', url('ai.yaml'), { bearer: t, body: { source: VALID_SCRIPT, origin: 'ai_mcp' } });
    expect(r.status).toBe(201);
    expect(r.body.version.origin).toBe('ai_mcp');
    const act = await env.req('GET', `/api/projects/${pid}/activity?actor=ai`, { cookie: a.cookie });
    expect(act.body.entries[0].actor).toMatchObject({ type: 'ai', id: b.id, label: 'AI — bob (my-claude)' });
  });

  it('suites reference scripts by id and follow renames', async () => {
    const s1 = (await env.req('PUT', url('suite/one.yaml'), { cookie: a.cookie, body: { source: VALID_SCRIPT } })).body.script.id;
    const created = await env.req('POST', `/api/projects/${pid}/suites`, { cookie: b.cookie, body: { name: 'Smoke', scriptIds: [s1] } });
    expect(created.status).toBe(201);
    expect((await env.req('POST', `/api/projects/${pid}/suites`, { cookie: b.cookie, body: { name: 'Bad', scriptIds: ['nope'] } })).status).toBe(422);
    await env.req('POST', url('suite/one.yaml', '/rename'), { cookie: a.cookie, body: { newPath: 'suite/uno.yaml' } });
    const list = await env.req('GET', `/api/projects/${pid}/suites`, { cookie: a.cookie });
    expect(list.body.suites[0].scripts).toEqual([{ id: s1, path: 'suite/uno.yaml' }]);
    const upd = await env.req('PATCH', `/api/projects/${pid}/suites/${created.body.id}`, { cookie: a.cookie, body: { name: 'Smoke 2', scriptIds: [] } });
    expect(upd.body).toMatchObject({ name: 'Smoke 2', scripts: [] });
    expect((await env.req('DELETE', `/api/projects/${pid}/suites/${created.body.id}`, { cookie: a.cookie })).status).toBe(204);
  });
});
