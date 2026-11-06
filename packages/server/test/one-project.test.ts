// Stage 15 "한 프로젝트 + 권한" (SPEC_클라우드-계정-프로젝트 "만들기·공개·구성원", SPEC_클라우드-앱-연동):
// birth record + "이어서 하기", members-only 404, receive list, access-request lifecycle (one open per
// user, 30-day expiry, approve with another role, notifications), leave / transfer, merge gate
// (three rejection kinds + unknown claimed once), admin owner assignment, activity entries, SSE access_lost.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DAY_MS } from '../src/clock.js';
import { projects, userEvents } from '../src/db/schema.js';
import { purgeExpired } from '../src/services/purge.js';
import { TestEnv, VALID_SCRIPT } from './helpers.js';
import { collect } from './sse.js';

type U = { id: string; cookie: string };

describe('one project + permissions', () => {
  let env: TestEnv;
  let base: string;
  let a: U; // owner
  let b: U; // org member
  let c: U; // org member
  let admin: string;
  let n = 0;

  beforeAll(async () => {
    env = await TestEnv.create();
    base = (await env.listen()).publicUrl;
    a = await env.user('alice@example.com');
    b = await env.user('bob@example.com');
    c = await env.user('carol@example.com');
    admin = await env.adminCookie();
  });
  afterAll(async () => env?.close());

  const create = async (body: Record<string, unknown> = {}, cookie = a.cookie) => env.req('POST', '/api/projects', { cookie, body: { name: `P${++n}`, ...body } });
  const activityKinds = async (pid: string, cookie = a.cookie) =>
    ((await env.req('GET', `/api/projects/${pid}/activity`, { cookie })).body.entries as { kind: string; actor: { label: string } }[]);

  describe('birth record', () => {
    it('web create is origin web; app create carries the local id; "이어서 하기" returns the same project', async () => {
      const web = await create();
      expect(web.status).toBe(201);
      expect(web.body).toMatchObject({ visibility: 'org', isMember: true, myRole: 'owner', birth: { origin: 'web', originLocalId: null, createdBy: { id: a.id, name: 'alice' } } });
      const app1 = await create({ origin: 'app', originLocalId: 'loc-A1' });
      expect(app1.status).toBe(201);
      expect(app1.body.birth).toMatchObject({ origin: 'app', originLocalId: 'loc-A1' });
      const again = await create({ origin: 'app', originLocalId: 'loc-A1' });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ id: app1.body.id, resumed: true });
      // Another person uploading their own project with the same local id gets a new project.
      const other = await create({ origin: 'app', originLocalId: 'loc-A1' }, b.cookie);
      expect(other.status).toBe(201);
      expect(other.body.id).not.toBe(app1.body.id);
      // origin app needs a local id (and only app takes one).
      expect((await create({ origin: 'app' })).status).toBe(422);
      expect((await create({ origin: 'web', originLocalId: 'x' })).status).toBe(422);
    });

    it('cannot be changed through PATCH', async () => {
      const p = await create({ origin: 'app', originLocalId: 'loc-imm' });
      const r = await env.req('PATCH', `/api/projects/${p.body.id}`, { cookie: a.cookie, body: { origin: 'web', originLocalId: 'evil', visibility: 'members' } });
      expect(r.status).toBe(200);
      expect(r.body.birth).toMatchObject({ origin: 'app', originLocalId: 'loc-imm' });
      expect(r.body.visibility).toBe('org');
    });
  });

  describe('visibility', () => {
    it('members-only: non-members get 404 everywhere and do not see it in lists; members and invited viewers do', async () => {
      const p = await create();
      const pid = p.body.id as string;
      await env.req('PUT', `/api/projects/${pid}/scripts/login.yaml`, { cookie: a.cookie, body: { source: VALID_SCRIPT } });
      await env.req('PUT', `/api/projects/${pid}/members/${c.id}`, { cookie: a.cookie, body: { role: 'viewer' } });
      expect((await env.req('GET', `/api/projects/${pid}`, { cookie: b.cookie })).status).toBe(200);
      const vis = await env.req('PUT', `/api/projects/${pid}/visibility`, { cookie: a.cookie, body: { visibility: 'members' } });
      expect(vis.status).toBe(200);
      expect(vis.body.visibility).toBe('members');
      for (const [method, url, body] of [
        ['GET', `/api/projects/${pid}`],
        ['GET', `/api/projects/${pid}/scripts`],
        ['GET', `/api/projects/${pid}/scripts/login.yaml`],
        ['GET', `/api/projects/${pid}/members`],
        ['GET', `/api/projects/${pid}/activity`],
        ['GET', `/api/projects/${pid}/runs`],
        ['GET', `/api/projects/${pid}/events`],
        ['POST', `/api/projects/${pid}/access-requests`, { role: 'editor' }],
        ['PUT', `/api/projects/${pid}/scripts/x.yaml`, { source: VALID_SCRIPT }],
      ] as const) {
        const r = await env.req(method, url, { cookie: b.cookie, ...(body ? { body } : {}) });
        expect(r.status, `${method} ${url}`).toBe(404);
        expect(r.body.error.code).toBe('NOT_FOUND');
      }
      const listB = (await env.req('GET', '/api/projects', { cookie: b.cookie })).body.projects.map((x: { id: string }) => x.id);
      expect(listB).not.toContain(pid);
      const recvB = (await env.req('GET', '/api/projects/receivable', { cookie: b.cookie })).body;
      expect([...recvB.mine, ...recvB.org].map((x: { id: string }) => x.id)).not.toContain(pid);
      // The invited viewer still sees it (in "mine", as viewer) — so does the admin? No: admins get no content privilege.
      expect((await env.req('GET', `/api/projects/${pid}`, { cookie: c.cookie })).body).toMatchObject({ myRole: 'viewer', isMember: true });
      const recvC = (await env.req('GET', '/api/projects/receivable', { cookie: c.cookie })).body;
      expect(recvC.mine.find((x: { id: string }) => x.id === pid)).toMatchObject({ myRole: 'viewer', visibility: 'members', canRequestAccess: true });
      expect((await env.req('GET', `/api/projects/${pid}`, { cookie: admin })).status).toBe(404);
      // Back to org: visible again as viewer.
      await env.req('PUT', `/api/projects/${pid}/visibility`, { cookie: a.cookie, body: { visibility: 'org' } });
      expect((await env.req('GET', `/api/projects/${pid}`, { cookie: b.cookie })).body).toMatchObject({ myRole: 'viewer', isMember: false });
      const kinds = (await activityKinds(pid)).map((e) => e.kind);
      expect(kinds.filter((k) => k === 'project.visibility_changed')).toHaveLength(2);
      expect(kinds).toContain('member.invited');
    });

    it('SSE: a viewer watching an org project gets access_lost when it becomes members-only', async () => {
      const pid = (await create()).body.id as string;
      const live = collect(`${base}/api/projects/${pid}/events`, { cookie: b.cookie }, (evs) => evs.some((e) => e.event === 'access_lost'), 8000);
      await new Promise((r) => setTimeout(r, 300));
      await env.req('PUT', `/api/projects/${pid}/visibility`, { cookie: a.cookie, body: { visibility: 'members' } });
      const evs = await live;
      expect(evs.map((e) => e.event)).toEqual(['ready', 'change', 'access_lost']);
      expect(evs[1]!.data).toMatchObject({ kind: 'project.visibility_changed', data: { visibility: 'members' } });
      expect(evs[2]!.data).toEqual({ reason: 'not_visible' });
    });

    it('SSE: a removed member of a members-only project gets access_lost; role changes arrive as change events', async () => {
      const pid = (await create()).body.id as string;
      await env.req('PUT', `/api/projects/${pid}/visibility`, { cookie: a.cookie, body: { visibility: 'members' } });
      await env.req('PUT', `/api/projects/${pid}/members/${b.id}`, { cookie: a.cookie, body: { role: 'editor' } });
      const live = collect(`${base}/api/projects/${pid}/events`, { cookie: b.cookie }, (evs) => evs.some((e) => e.event === 'access_lost'), 8000);
      await new Promise((r) => setTimeout(r, 300));
      await env.req('PUT', `/api/projects/${pid}/members/${b.id}`, { cookie: a.cookie, body: { role: 'runner' } });
      await env.req('DELETE', `/api/projects/${pid}/members/${b.id}`, { cookie: a.cookie });
      const evs = await live;
      expect(evs.map((e) => e.event)).toEqual(['ready', 'change', 'change', 'access_lost']);
      expect(evs[1]!.data).toMatchObject({ kind: 'member.role_changed', data: { targetId: b.id, role: 'runner', previousRole: 'editor' } });
      expect(evs[2]!.data).toMatchObject({ kind: 'member.removed', data: { targetId: b.id } });
    });
  });

  describe('access requests', () => {
    it('request → owner notified → approve with a different role → requester notified; one open per user', async () => {
      const pid = (await create()).body.id as string;
      const r = await env.req('POST', `/api/projects/${pid}/access-requests`, { cookie: b.cookie, body: { role: 'editor', memo: '스크립트 고치려고요' } });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ projectId: pid, user: { id: b.id, name: 'bob' }, role: 'editor', memo: '스크립트 고치려고요', status: 'open', grantedRole: null });
      expect(new Date(r.body.expiresAt).getTime() - new Date(r.body.createdAt).getTime()).toBe(30 * DAY_MS);
      const dup = await env.req('POST', `/api/projects/${pid}/access-requests`, { cookie: b.cookie, body: { role: 'runner' } });
      expect(dup.status).toBe(409);
      expect(dup.body.error).toMatchObject({ code: 'REQUEST_OPEN', details: { requestId: r.body.id } });
      // Receive list shows "요청 중".
      const recv = (await env.req('GET', '/api/projects/receivable', { cookie: b.cookie })).body;
      expect(recv.org.find((x: { id: string }) => x.id === pid)).toMatchObject({ myRole: 'viewer', canRequestAccess: false, openRequest: { id: r.body.id, role: 'editor' } });
      // Owner sees it; the requester sees only their own; another viewer sees none.
      expect((await env.req('GET', `/api/projects/${pid}/access-requests?status=open`, { cookie: a.cookie })).body.requests).toHaveLength(1);
      expect((await env.req('GET', `/api/projects/${pid}/access-requests`, { cookie: c.cookie })).body.requests).toHaveLength(0);
      expect((await env.req('GET', '/api/me/access-requests?status=open', { cookie: b.cookie })).body.requests.map((x: { id: string }) => x.id)).toContain(r.body.id);
      // Only the owner decides.
      expect((await env.req('POST', `/api/projects/${pid}/access-requests/${r.body.id}/approve`, { cookie: b.cookie, body: {} })).status).toBe(403);
      const ok = await env.req('POST', `/api/projects/${pid}/access-requests/${r.body.id}/approve`, { cookie: a.cookie, body: { role: 'runner' } });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: 'approved', grantedRole: 'runner', decidedBy: { id: a.id, name: 'alice' } });
      expect((await env.req('GET', `/api/projects/${pid}`, { cookie: b.cookie })).body.myRole).toBe('runner');
      expect((await env.req('POST', `/api/projects/${pid}/access-requests/${r.body.id}/reject`, { cookie: a.cookie })).status).toBe(409);
      // Notifications: owner got access.requested, requester got access.approved.
      const evA = await env.ctx.db.select().from(userEvents).where(eq(userEvents.userId, a.id));
      expect(evA.find((e) => e.kind === 'access.requested' && e.projectId === pid)?.data).toMatchObject({ requestId: r.body.id, requester: { id: b.id, name: 'bob' }, role: 'editor' });
      const evB = await env.ctx.db.select().from(userEvents).where(eq(userEvents.userId, b.id));
      expect(evB.find((e) => e.kind === 'access.approved' && e.projectId === pid)?.data).toMatchObject({ requestId: r.body.id, role: 'editor', grantedRole: 'runner' });
      // A runner may ask for editor; an editor may not ask for runner/editor (not higher).
      const up = await env.req('POST', `/api/projects/${pid}/access-requests`, { cookie: b.cookie, body: { role: 'editor' } });
      expect(up.status).toBe(201);
      const rej = await env.req('POST', `/api/projects/${pid}/access-requests/${up.body.id}/reject`, { cookie: a.cookie });
      expect(rej.body).toMatchObject({ status: 'rejected', grantedRole: null });
      expect((await env.ctx.db.select().from(userEvents).where(eq(userEvents.userId, b.id))).some((e) => e.kind === 'access.rejected')).toBe(true);
      expect((await env.req('GET', `/api/projects/${pid}`, { cookie: b.cookie })).body.myRole).toBe('runner');
      await env.req('PUT', `/api/projects/${pid}/members/${c.id}`, { cookie: a.cookie, body: { role: 'editor' } });
      const notHigher = await env.req('POST', `/api/projects/${pid}/access-requests`, { cookie: c.cookie, body: { role: 'runner' } });
      expect(notHigher.status).toBe(409);
      expect(notHigher.body.error.code).toBe('ALREADY_HAS_ROLE');
      // Owners have nothing to ask for.
      expect((await env.req('POST', `/api/projects/${pid}/access-requests`, { cookie: a.cookie, body: { role: 'editor' } })).status).toBe(403);
      const kinds = (await activityKinds(pid)).map((e) => e.kind);
      expect(kinds).toEqual(expect.arrayContaining(['access.requested', 'access.approved', 'access.rejected']));
    });

    it('open requests expire after 30 days: cannot be approved, and a new request is possible', async () => {
      const pid = (await create()).body.id as string;
      const r = await env.req('POST', `/api/projects/${pid}/access-requests`, { cookie: c.cookie, body: { role: 'runner' } });
      expect(r.status).toBe(201);
      env.clock.advance(29 * DAY_MS);
      expect((await env.req('GET', `/api/projects/${pid}/access-requests?status=open`, { cookie: a.cookie })).body.requests).toHaveLength(1);
      env.clock.advance(1 * DAY_MS + 1000);
      try {
        expect((await env.req('GET', `/api/projects/${pid}/access-requests?status=open`, { cookie: a.cookie })).body.requests).toHaveLength(0);
        expect((await env.req('GET', `/api/projects/${pid}/access-requests?status=expired`, { cookie: a.cookie })).body.requests[0]).toMatchObject({ id: r.body.id, status: 'expired' });
        const late = await env.req('POST', `/api/projects/${pid}/access-requests/${r.body.id}/approve`, { cookie: a.cookie, body: {} });
        expect(late.status).toBe(409);
        expect(late.body.error.code).toBe('REQUEST_CLOSED');
        const again = await env.req('POST', `/api/projects/${pid}/access-requests`, { cookie: c.cookie, body: { role: 'runner' } });
        expect(again.status).toBe(201);
        // The purge sweep also expires stale open requests.
        env.clock.advance(31 * DAY_MS);
        await purgeExpired(env.ctx);
        expect((await env.req('GET', `/api/me/access-requests?status=open`, { cookie: c.cookie })).body.requests.find((x: { projectId: string }) => x.projectId === pid)).toBeUndefined();
      } finally {
        env.clock.offsetMs = 0;
      }
    });
  });

  describe('leave · transfer', () => {
    it('the last owner cannot leave; others can; a non-member has nothing to leave', async () => {
      const pid = (await create()).body.id as string;
      await env.req('PUT', `/api/projects/${pid}/members/${b.id}`, { cookie: a.cookie, body: { role: 'runner' } });
      const last = await env.req('POST', `/api/projects/${pid}/leave`, { cookie: a.cookie });
      expect(last.status).toBe(409);
      expect(last.body.error.code).toBe('LAST_OWNER');
      expect((await env.req('POST', `/api/projects/${pid}/leave`, { cookie: b.cookie })).status).toBe(204);
      expect((await env.req('GET', `/api/projects/${pid}`, { cookie: b.cookie })).body).toMatchObject({ myRole: 'viewer', isMember: false });
      const none = await env.req('POST', `/api/projects/${pid}/leave`, { cookie: c.cookie });
      expect(none.status).toBe(409);
      expect(none.body.error.code).toBe('NOT_MEMBER');
      expect((await activityKinds(pid)).find((e) => e.kind === 'member.left')).toBeTruthy();
    });

    it('transfer: target becomes owner, I step down (or leave) in one action; owner-only', async () => {
      const pid = (await create()).body.id as string;
      await env.req('PUT', `/api/projects/${pid}/members/${b.id}`, { cookie: a.cookie, body: { role: 'editor' } });
      expect((await env.req('POST', `/api/projects/${pid}/transfer`, { cookie: b.cookie, body: { userId: c.id, myRole: 'editor' } })).status).toBe(403);
      expect((await env.req('POST', `/api/projects/${pid}/transfer`, { cookie: a.cookie, body: { userId: a.id, myRole: 'editor' } })).status).toBe(409);
      const t = await env.req('POST', `/api/projects/${pid}/transfer`, { cookie: a.cookie, body: { userId: b.id, myRole: 'runner' } });
      expect(t.status).toBe(200);
      const roles = Object.fromEntries(t.body.members.map((m: { userId: string; role: string }) => [m.userId, m.role]));
      expect(roles).toEqual({ [a.id]: 'runner', [b.id]: 'owner' });
      const t2 = await env.req('POST', `/api/projects/${pid}/transfer`, { cookie: b.cookie, body: { userId: c.id, myRole: 'leave' } });
      expect(t2.body.members.map((m: { userId: string; role: string }) => [m.userId, m.role]).sort()).toEqual([[a.id, 'runner'], [c.id, 'owner']].sort());
      expect((await activityKinds(pid)).filter((e) => e.kind === 'project.transferred')).toHaveLength(2);
    });
  });

  describe('merge gate', () => {
    const compact = (id: string) => id.replace(/-/g, '');

    it('accepts the owner of an app project with the same local id', async () => {
      const p = await create({ origin: 'app', originLocalId: 'loc-M1' });
      const ok = await env.req('POST', `/api/projects/${p.body.id}/merge/check`, { cookie: a.cookie, body: { localProjectId: 'loc-M1' } });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ ok: true, origin: 'app' });
      const done = await env.req('POST', `/api/projects/${p.body.id}/merge`, { cookie: a.cookie, body: { localProjectId: 'loc-M1', summary: { scriptsUploaded: 2, runsMoved: 5 } } });
      expect(done.status).toBe(200);
      expect((await activityKinds(p.body.id)).find((e) => e.kind === 'project.merged')).toBeTruthy();
    });

    it('rejection 1: a web-born project (ORIGIN_MISMATCH web_origin), even for its owner', async () => {
      const p = await create();
      const r = await env.req('POST', `/api/projects/${p.body.id}/merge/check`, { cookie: a.cookie, body: { localProjectId: 'loc-X', uploadedTo: { projectId: p.body.id, localId: compact(p.body.id) } } });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatchObject({ code: 'ORIGIN_MISMATCH', details: { reason: 'web_origin' } });
      expect((await env.req('POST', `/api/projects/${p.body.id}/merge`, { cookie: a.cookie, body: { localProjectId: 'loc-X' } })).body.error.code).toBe('ORIGIN_MISMATCH');
    });

    it('rejection 2: an app project uploaded from a different local project (ORIGIN_MISMATCH local_id_mismatch)', async () => {
      const p = await create({ origin: 'app', originLocalId: 'loc-M2' });
      const r = await env.req('POST', `/api/projects/${p.body.id}/merge/check`, { cookie: a.cookie, body: { localProjectId: 'loc-OTHER' } });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatchObject({ code: 'ORIGIN_MISMATCH', details: { reason: 'local_id_mismatch' } });
    });

    it("rejection 3: someone else's project — not an owner (FORBIDDEN not_owner), even an editor with the right local id", async () => {
      const p = await create({ origin: 'app', originLocalId: 'loc-M3' });
      await env.req('PUT', `/api/projects/${p.body.id}/members/${b.id}`, { cookie: a.cookie, body: { role: 'editor' } });
      for (const who of [b, c]) {
        const r = await env.req('POST', `/api/projects/${p.body.id}/merge/check`, { cookie: who.cookie, body: { localProjectId: 'loc-M3' } });
        expect(r.status).toBe(403);
        expect(r.body.error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'not_owner' } });
      }
    });

    it('unknown (pre-stage-15) project: owner + matching link record is accepted once and fills the birth record', async () => {
      const p = await create();
      const pid = p.body.id as string;
      await env.ctx.db.update(projects).set({ origin: 'unknown', originLocalId: null }).where(eq(projects.id, pid));
      const bad = await env.req('POST', `/api/projects/${pid}/merge/check`, { cookie: a.cookie, body: { localProjectId: 'loc-U', uploadedTo: { projectId: pid, localId: 'deadbeef' } } });
      expect(bad.body.error).toMatchObject({ code: 'ORIGIN_MISMATCH', details: { reason: 'link_mismatch' } });
      expect((await env.req('POST', `/api/projects/${pid}/merge/check`, { cookie: a.cookie, body: { localProjectId: 'loc-U' } })).body.error.details.reason).toBe('link_mismatch');
      const link = { projectId: pid, localId: compact(pid) };
      expect((await env.req('POST', `/api/projects/${pid}/merge/check`, { cookie: a.cookie, body: { localProjectId: 'loc-U', uploadedTo: link } })).body).toMatchObject({ ok: true, origin: 'unknown' });
      const done = await env.req('POST', `/api/projects/${pid}/merge`, { cookie: a.cookie, body: { localProjectId: 'loc-U', uploadedTo: link } });
      expect(done.body.project.birth).toMatchObject({ origin: 'app', originLocalId: 'loc-U' });
      // Now fixed: a different local project cannot claim it any more.
      const second = await env.req('POST', `/api/projects/${pid}/merge/check`, { cookie: a.cookie, body: { localProjectId: 'loc-U2', uploadedTo: link } });
      expect(second.body.error).toMatchObject({ code: 'ORIGIN_MISMATCH', details: { reason: 'local_id_mismatch' } });
    });
  });

  describe('admin owner assignment', () => {
    it('lists only projects whose owners are all deactivated; assigns a new owner; no other privilege', async () => {
      const d = await env.user('dora@example.com');
      const pid = (await create({}, d.cookie)).body.id as string;
      await env.req('PUT', `/api/projects/${pid}/visibility`, { cookie: d.cookie, body: { visibility: 'members' } });
      await env.req('PUT', `/api/projects/${pid}/members/${c.id}`, { cookie: d.cookie, body: { role: 'editor' } });
      const healthy = (await create()).body.id as string;
      // Non-admins cannot use the admin endpoints.
      expect((await env.req('GET', '/api/admin/projects/ownerless', { cookie: a.cookie })).status).toBe(403);
      expect((await env.req('GET', '/api/admin/projects/ownerless', { cookie: admin })).body.projects.map((p: { id: string }) => p.id)).not.toContain(pid);
      // Assigning on a project that still has an active owner is refused.
      expect((await env.req('POST', `/api/admin/projects/${healthy}/owner`, { cookie: admin, body: { userId: b.id } })).status).toBe(403);
      await env.req('POST', `/api/admin/users/${d.id}/deactivate`, { cookie: admin });
      const list = (await env.req('GET', '/api/admin/projects/ownerless', { cookie: admin })).body.projects;
      const row = list.find((p: { id: string }) => p.id === pid);
      expect(row).toMatchObject({ visibility: 'members', owners: [{ id: d.id, status: 'deactivated' }], members: [{ id: c.id, role: 'editor' }] });
      // Admin still can't read the members-only project's content.
      expect((await env.req('GET', `/api/projects/${pid}/scripts`, { cookie: admin })).status).toBe(404);
      const assigned = await env.req('POST', `/api/admin/projects/${pid}/owner`, { cookie: admin, body: { userId: c.id } });
      expect(assigned.status).toBe(200);
      expect(assigned.body.projects.map((p: { id: string }) => p.id)).not.toContain(pid);
      expect((await env.req('GET', `/api/projects/${pid}`, { cookie: c.cookie })).body.myRole).toBe('owner');
      const entry = (await activityKinds(pid, c.cookie)).find((e) => e.kind === 'project.owner_assigned');
      expect(entry?.actor.label).toMatch(/^관리자/);
      // Deactivated target refused.
      expect((await env.req('POST', `/api/admin/projects/${pid}/owner`, { cookie: admin, body: { userId: d.id } })).status).toBe(403);
    });

    it('demoting the last active owner is refused even when a deactivated owner remains', async () => {
      const e = await env.user('erin@example.com');
      const pid = (await create()).body.id as string;
      await env.req('PUT', `/api/projects/${pid}/members/${e.id}`, { cookie: a.cookie, body: { role: 'owner' } });
      await env.req('POST', `/api/admin/users/${e.id}/deactivate`, { cookie: admin });
      const r = await env.req('PUT', `/api/projects/${pid}/members/${a.id}`, { cookie: a.cookie, body: { role: 'editor' } });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('LAST_OWNER');
      // Removing the deactivated owner is fine.
      expect((await env.req('DELETE', `/api/projects/${pid}/members/${e.id}`, { cookie: a.cookie })).status).toBe(204);
    });
  });
});
