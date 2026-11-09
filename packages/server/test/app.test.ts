// Static web (placeholder when not built) · SPA fallback · public config · JSON 404 envelope · health · readiness.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers.js';

describe('app shell', () => {
  let env: TestEnv;
  let withWeb: TestEnv;
  beforeAll(async () => {
    env = await TestEnv.create();
    const dist = mkdtempSync(join(tmpdir(), 'euta-web-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>built web</title>');
    writeFileSync(join(dist, 'app.js'), 'console.log(1)');
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'index-abc.js'), 'console.log(2)');
    withWeb = await TestEnv.create({ config: { webDist: dist } });
  });
  afterAll(async () => {
    await withWeb?.close();
    await env?.close();
  });

  it('serves a placeholder page when no web build exists', async () => {
    const r = await env.req('GET', '/');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toMatch(/text\/html/);
    expect(r.text).toContain('euta cloud');
  });

  it('serves the web build with SPA fallback', async () => {
    expect((await withWeb.req('GET', '/')).text).toContain('built web');
    expect((await withWeb.req('GET', '/app.js')).text).toContain('console.log');
    expect((await withWeb.req('GET', '/assets/index-abc.js')).text).toContain('console.log(2)');
    expect((await withWeb.req('GET', '/projects/123/scripts')).text).toContain('built web');
    // Device approval page opened by the local app (verification_uri_complete).
    expect((await withWeb.req('GET', '/device?user_code=ABCD1234')).text).toContain('built web');
  });

  it('unknown API routes get the JSON error envelope', async () => {
    const r = await env.req('GET', '/api/nope');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    const bad = await env.req('POST', '/api/projects', { body: 'not json', headers: { 'content-type': 'application/json' } });
    expect(bad.body.error.code).toBeDefined();
  });

  it('public server config tells the web which sign-up mode is on', async () => {
    const approval = await TestEnv.create({ approvalMode: true });
    try {
      expect((await approval.req('GET', '/api/config')).body).toEqual({ signUpMode: 'approval', allowedEmailDomains: ['example.com'], microsoftLogin: false, appUpdates: false });
    } finally {
      await approval.close();
    }
    expect((await env.req('GET', '/api/config')).body).toEqual({ signUpMode: 'email', allowedEmailDomains: ['example.com'], microsoftLogin: false, appUpdates: false });
  });

  it('health check', async () => {
    expect((await env.req('GET', '/healthz')).body).toEqual({ ok: true });
  });

  it('readiness check reports the database', async () => {
    expect((await env.req('GET', '/readyz')).body).toEqual({ ok: true });
    const query = env.ctx.pool.query;
    env.ctx.pool.query = (async () => {
      throw new Error('connection refused');
    }) as never;
    try {
      const r = await env.req('GET', '/readyz');
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('NOT_READY');
    } finally {
      env.ctx.pool.query = query;
    }
  });
});
