// Org user search for invites (SPEC API "사용자 검색"): GET /api/users?q= — any active member
// (session or token), active users only, name/email prefix (case-insensitive), at most 20, id/name/email.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema.js';
import { TestEnv } from './helpers.js';

describe('GET /api/users (invite search)', () => {
  let env: TestEnv;
  let viewer: { id: string; cookie: string };
  let kim: { id: string };

  beforeAll(async () => {
    env = await TestEnv.create({ approvalMode: true });
    viewer = await env.user('viewer@example.com');
    kim = await env.user('kim.minsu@example.com');
    // Pending (never approved) and deactivated accounts must not show up.
    await env.signUp('kim.pending@example.com');
    const gone = await env.user('kim.gone@example.com');
    await env.req('POST', `/api/admin/users/${gone.id}/deactivate`, { cookie: await env.adminCookie() });
    // Bulk active users to check the 20-result cap and ordering.
    await env.ctx.db.insert(users).values(
      Array.from({ length: 22 }, (_, i) => ({ id: randomUUID(), name: `bulk${String(i + 1).padStart(2, '0')}`, email: `bulk${i + 1}@example.com`, status: 'active' })),
    );
  });
  afterAll(async () => env?.close());

  const search = (q: string | null, auth: { cookie?: string; bearer?: string } = { cookie: viewer.cookie }) =>
    env.req('GET', q === null ? '/api/users' : `/api/users?q=${encodeURIComponent(q)}`, auth);

  it('needs a signed-in member', async () => {
    expect((await search('kim', {})).status).toBe(401);
  });

  it('matches name or email prefixes, case-insensitively, active users only, id/name/email only', async () => {
    const r = await search('KIM');
    expect(r.status).toBe(200);
    expect(r.body.users).toEqual([{ id: kim.id, name: 'kim.minsu', email: 'kim.minsu@example.com' }]);
    expect((await search('kim.minsu@exam')).body.users.map((u: { id: string }) => u.id)).toEqual([kim.id]);
    // Prefix, not substring.
    expect((await search('minsu')).body.users).toEqual([]);
  });

  it('caps results at 20, ordered by name; an empty q lists the first 20', async () => {
    const r = await search('bulk');
    expect(r.body.users).toHaveLength(20);
    expect(r.body.users[0].name).toBe('bulk01');
    expect(r.body.users[19].name).toBe('bulk20');
    const all = await search(null);
    expect(all.body.users).toHaveLength(20);
    expect(all.body.users.every((u: { email: string }) => !u.email.includes('pending') && !u.email.includes('gone'))).toBe(true);
  });

  it('treats LIKE wildcards literally and rejects overly long queries', async () => {
    expect((await search('%')).body.users).toEqual([]);
    expect((await search('_')).body.users).toEqual([]);
    expect((await search('x'.repeat(101))).status).toBe(422);
  });

  it('works with a read-only personal token', async () => {
    const token = (await env.req('POST', '/api/me/tokens', { cookie: viewer.cookie, body: { name: 'mcp', permission: 'read' } })).body.token as string;
    const r = await search('kim', { bearer: token });
    expect(r.status).toBe(200);
    expect(r.body.users).toHaveLength(1);
  });
});
