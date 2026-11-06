// SPEC 환경 · 테스트 계정: public-address check, credential-like var keys, write-only credentials
// encrypted with AES-256-GCM.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { credentialAad, decryptSecret } from '../src/crypto.js';
import { credentials } from '../src/db/schema.js';
import { checkPublicAddress, isPrivateAddress } from '../src/services/address-check.js';
import { TestEnv, fakeResolver } from './helpers.js';

describe('public address check', () => {
  it('classifies addresses', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('checks host names', async () => {
    const r = fakeResolver(['intranet.example.com']);
    expect(await checkPublicAddress('https://dev.shop.example.com', r)).toEqual({ public: true });
    expect((await checkPublicAddress('https://intranet.example.com/x', r)).public).toBe(false);
    expect((await checkPublicAddress('http://localhost:3000', r)).public).toBe(false);
    expect((await checkPublicAddress('http://jenkins', r)).public).toBe(false);
    expect((await checkPublicAddress('http://svc.ns.svc.cluster.local', r)).public).toBe(false);
    expect((await checkPublicAddress('http://192.168.0.10', r)).public).toBe(false);
    expect((await checkPublicAddress('http://[::1]:8080', r)).public).toBe(false);
    expect((await checkPublicAddress('https://unresolvable.example', async () => Promise.reject(new Error('ENOTFOUND')))).public).toBe(false);
  });
});

describe('environments and credentials', () => {
  let env: TestEnv;
  let owner: { id: string; cookie: string };
  let viewer: { id: string; cookie: string };
  let pid: string;
  beforeAll(async () => {
    env = await TestEnv.create();
    owner = await env.user('owner@example.com');
    viewer = await env.user('viewer@example.com');
    pid = (await env.req('POST', '/api/projects', { cookie: owner.cookie, body: { name: 'P' } })).body.id;
  });
  afterAll(async () => env?.close());

  it('creates an environment with default allowed domain and public check', async () => {
    const r = await env.req('POST', `/api/projects/${pid}/environments`, {
      cookie: owner.cookie,
      body: { name: 'dev', baseUrl: 'https://dev.shop.example.com/app', vars: { REGION: 'kr' }, makeDefault: true },
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'dev', allowedDomains: ['dev.shop.example.com'], cloudRunnable: true, isDefault: true, vars: { REGION: 'kr' }, credentialNames: [] });
    expect((await env.req('GET', `/api/projects/${pid}`, { cookie: owner.cookie })).body.defaultEnvironmentId).toBe(r.body.id);
    expect((await env.req('POST', `/api/projects/${pid}/environments`, { cookie: owner.cookie, body: { name: 'dev', baseUrl: 'https://x.example.com' } })).status).toBe(409);
  });

  it('private / internal base URL is saved but marked cloud-run not possible', async () => {
    const r = await env.req('POST', `/api/projects/${pid}/environments`, { cookie: owner.cookie, body: { name: 'intra', baseUrl: 'https://intranet.example.com' } });
    expect(r.status).toBe(201);
    expect(r.body.cloudRunnable).toBe(false);
    expect(r.body.addressCheck.reason).toMatch(/private/);
    // Moving to a public address clears the flag and follows the default allowed domain.
    const u = await env.req('PATCH', `/api/projects/${pid}/environments/${r.body.id}`, { cookie: owner.cookie, body: { baseUrl: 'https://public.example.com' } });
    expect(u.body).toMatchObject({ cloudRunnable: true, allowedDomains: ['public.example.com'] });
  });

  it('rejects credential-looking variable keys, bad URLs and URL credentials (422)', async () => {
    for (const vars of [{ API_TOKEN: 'x' }, { PASSWORD: 'x' }, { api_key: 'x' }, { 'bad key': 'x' }]) {
      const r = await env.req('POST', `/api/projects/${pid}/environments`, { cookie: owner.cookie, body: { name: `v${Math.random()}`.slice(0, 10), baseUrl: 'https://a.example.com', vars } });
      expect(r.status).toBe(422);
      expect(JSON.stringify(r.body.error.details)).not.toContain('"x"');
    }
    for (const baseUrl of ['ftp://a.example.com', 'not a url', '/relative', 'https://user:pw@a.example.com']) {
      expect((await env.req('POST', `/api/projects/${pid}/environments`, { cookie: owner.cookie, body: { name: 'bad', baseUrl } })).status).toBe(422);
    }
  });

  it('credentials are write-only and encrypted (AES-256-GCM, bound to their slot)', async () => {
    const e = (await env.req('POST', `/api/projects/${pid}/environments`, { cookie: owner.cookie, body: { name: 'cred', baseUrl: 'https://c.example.com' } })).body;
    const value = 'P@ss-unique-7f3a91';
    const put = await env.req('PUT', `/api/projects/${pid}/environments/${e.id}/credentials/USER_PASSWORD`, { cookie: owner.cookie, body: { value } });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ name: 'USER_PASSWORD', updatedBy: { id: owner.id } });
    expect(put.text).not.toContain(value);
    const list = await env.req('GET', `/api/projects/${pid}/environments/${e.id}/credentials`, { cookie: viewer.cookie });
    expect(list.body.credentials).toEqual([{ name: 'USER_PASSWORD', updatedAt: expect.any(String), updatedBy: { id: owner.id, name: 'owner' } }]);
    expect((await env.req('GET', `/api/projects/${pid}/environments`, { cookie: viewer.cookie })).body.environments.find((x: { id: string }) => x.id === e.id).credentialNames).toEqual(['USER_PASSWORD']);

    const [row] = await env.ctx.db.select().from(credentials).where(eq(credentials.environmentId, e.id));
    expect(row!.ciphertext).toMatch(/^v1:/);
    expect(row!.ciphertext).not.toContain(value);
    expect(decryptSecret(env.ctx.config.credentialsKey, credentialAad(e.id, 'USER_PASSWORD'), row!.ciphertext)).toBe(value);
    expect(() => decryptSecret(env.ctx.config.credentialsKey, credentialAad(e.id, 'OTHER'), row!.ciphertext)).toThrow();
    expect(() => decryptSecret(Buffer.alloc(32, 1), credentialAad(e.id, 'USER_PASSWORD'), row!.ciphertext)).toThrow();

    // Overwrite → new ciphertext, activity without value; delete.
    await env.req('PUT', `/api/projects/${pid}/environments/${e.id}/credentials/USER_PASSWORD`, { cookie: owner.cookie, body: { value: 'second-value-xyz' } });
    const act = await env.req('GET', `/api/projects/${pid}/activity?kind=credential`, { cookie: owner.cookie });
    expect(act.body.entries.map((x: { kind: string }) => x.kind)).toEqual(['credential.changed', 'credential.added']);
    expect(act.text).not.toContain(value);
    expect(act.text).not.toContain('second-value-xyz');
    expect((await env.req('DELETE', `/api/projects/${pid}/environments/${e.id}/credentials/USER_PASSWORD`, { cookie: owner.cookie })).status).toBe(204);
    expect((await env.req('DELETE', `/api/projects/${pid}/environments/${e.id}/credentials/USER_PASSWORD`, { cookie: owner.cookie })).status).toBe(404);
  });

  it('validates credential names and value size', async () => {
    const e = (await env.req('POST', `/api/projects/${pid}/environments`, { cookie: owner.cookie, body: { name: 'cred2', baseUrl: 'https://c.example.com' } })).body;
    const base = `/api/projects/${pid}/environments/${e.id}/credentials`;
    expect((await env.req('PUT', `${base}/9BAD`, { cookie: owner.cookie, body: { value: 'v' } })).status).toBe(422);
    expect((await env.req('PUT', `${base}/${'A'.repeat(65)}`, { cookie: owner.cookie, body: { value: 'v' } })).status).toBe(422);
    const big = await env.req('PUT', `${base}/BIG`, { cookie: owner.cookie, body: { value: 'z'.repeat(16 * 1024 + 1) } });
    expect(big.status).toBe(422);
    expect(big.text).not.toContain('zzzzzzzz');
    expect((await env.req('PUT', `${base}/MAX`, { cookie: owner.cookie, body: { value: 'z'.repeat(16 * 1024) } })).status).toBe(200);
  });

  it('deleting an environment deletes its credentials and clears the default', async () => {
    const e = (await env.req('POST', `/api/projects/${pid}/environments`, { cookie: owner.cookie, body: { name: 'tmp', baseUrl: 'https://t.example.com', makeDefault: true } })).body;
    await env.req('PUT', `/api/projects/${pid}/environments/${e.id}/credentials/K`, { cookie: owner.cookie, body: { value: 'v' } });
    expect((await env.req('DELETE', `/api/projects/${pid}/environments/${e.id}`, { cookie: owner.cookie })).status).toBe(204);
    expect(await env.ctx.db.$count(credentials, eq(credentials.environmentId, e.id))).toBe(0);
    expect((await env.req('GET', `/api/projects/${pid}`, { cookie: owner.cookie })).body.defaultEnvironmentId).toBeNull();
  });
});
