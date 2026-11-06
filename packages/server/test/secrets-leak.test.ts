// 완료 기준 C1: test credential plaintext appears in no API response, no log line, no activity entry
// and nowhere in the database (full data dump). Also checks raw personal tokens and passwords.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, TestEnv, VALID_SCRIPT, dumpDatabase } from './helpers.js';

describe('no plaintext secrets anywhere', () => {
  let env: TestEnv;
  const SECRET_1 = 'Cred-Value-1-a8f3e2d1c0';
  const SECRET_2 = 'Cred-Value-2-77bb99aa11';
  const SECRET_3 = 'Cred-Value-3-deadbeef42';
  let rawToken = '';

  beforeAll(async () => {
    env = await TestEnv.create();
    const owner = await env.user('owner@example.com');
    const editor = await env.user('editor@example.com');
    const viewer = await env.user('viewer@example.com');
    const pid = (await env.req('POST', '/api/projects', { cookie: owner.cookie, body: { name: 'Leak check' } })).body.id;
    await env.req('PUT', `/api/projects/${pid}/members/${editor.id}`, { cookie: owner.cookie, body: { role: 'editor' } });
    const e = (await env.req('POST', `/api/projects/${pid}/environments`, { cookie: owner.cookie, body: { name: 'dev', baseUrl: 'https://dev.example.com' } })).body;
    const cred = `/api/projects/${pid}/environments/${e.id}/credentials`;
    rawToken = (await env.req('POST', '/api/me/tokens', { cookie: editor.cookie, body: { name: 'mcp', permission: 'read_write' } })).body.token;

    // Writes: owner session, editor token; overwrite; delete; denied and invalid attempts.
    await env.req('PUT', `${cred}/USER_PASSWORD`, { cookie: owner.cookie, body: { value: SECRET_1 } });
    await env.req('PUT', `${cred}/USER_PASSWORD`, { bearer: rawToken, body: { value: SECRET_2 } });
    await env.req('PUT', `${cred}/OTHER`, { cookie: editor.cookie, body: { value: SECRET_3 } });
    await env.req('DELETE', `${cred}/OTHER`, { cookie: editor.cookie });
    await env.req('PUT', `${cred}/DENIED`, { cookie: viewer.cookie, body: { value: SECRET_1 } }); // 403
    await env.req('PUT', `${cred}/9invalid`, { cookie: owner.cookie, body: { value: SECRET_1 } }); // 422 name
    await env.req('PUT', `${cred}/EMPTYOBJ`, { cookie: owner.cookie, body: { value: { nested: SECRET_1 } } }); // 422 type
    await env.req('PUT', `${cred}/HUGE`, { cookie: owner.cookie, body: { value: SECRET_1 + 'x'.repeat(17000) } }); // 422 size
    await env.req('POST', `/api/projects/${pid}/environments`, { cookie: owner.cookie, body: { name: 'v', baseUrl: 'https://a.example.com', vars: { API_TOKEN: SECRET_1 } } }); // 422

    // A script that references the credential (reference only, never the value).
    await env.req('PUT', `/api/projects/${pid}/scripts/login.yaml`, { cookie: editor.cookie, body: { source: VALID_SCRIPT } });

    // Reads by everyone, every endpoint of this stage.
    for (const auth of [{ cookie: owner.cookie }, { cookie: editor.cookie }, { cookie: viewer.cookie }, { bearer: rawToken }]) {
      for (const u of [
        '/api/me',
        '/api/projects',
        `/api/projects/${pid}`,
        `/api/projects/${pid}/members`,
        `/api/projects/${pid}/environments`,
        `${cred}`,
        `/api/projects/${pid}/scripts`,
        `/api/projects/${pid}/scripts/login.yaml`,
        `/api/projects/${pid}/scripts/login.yaml/versions`,
        `/api/projects/${pid}/suites`,
        `/api/projects/${pid}/activity?limit=200`,
      ]) {
        await env.req('GET', u, auth);
      }
    }
    await env.req('GET', '/api/me/tokens', { cookie: editor.cookie });
    await env.req('GET', '/api/admin/users', { cookie: await env.adminCookie() });
  });
  afterAll(async () => env?.close());

  const scans = () => ({
    responses: env.responses.join('\n'),
    logs: env.logs.join('\n'),
  });

  it('API responses contain no credential value', () => {
    const { responses } = scans();
    expect(env.responses.length).toBeGreaterThan(40);
    for (const s of [SECRET_1, SECRET_2, SECRET_3]) expect(responses).not.toContain(s);
  });

  it('logs (debug level) contain no credential value, raw token or password', () => {
    const { logs } = scans();
    expect(env.logs.length).toBeGreaterThan(40);
    for (const s of [SECRET_1, SECRET_2, SECRET_3, rawToken, rawToken.slice(5), PASSWORD]) expect(logs).not.toContain(s);
  });

  it('the database (every row of every table) contains no credential value, raw token or password', async () => {
    const dump = await dumpDatabase(env.dbUrl);
    expect(dump).toContain('USER_PASSWORD'); // the name is there…
    for (const s of [SECRET_1, SECRET_2, SECRET_3, rawToken, rawToken.slice(5), PASSWORD]) expect(dump).not.toContain(s); // …the values are not
  });

  it('the raw token appeared exactly once in responses (at creation)', () => {
    const hits = env.responses.filter((r) => r.includes(rawToken));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^POST \/api\/me\/tokens 201/);
  });
});
