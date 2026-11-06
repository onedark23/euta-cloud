// ADR-022 SSE change feed: live events with id = seq, resume via Last-Event-ID (header and query),
// resync when the position is older than the retained feed, fan-out across two server instances
// through Postgres LISTEN/NOTIFY.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changeFeed } from '../src/db/schema.js';
import { TestEnv, VALID_SCRIPT } from './helpers.js';

interface SseEvent {
  id?: string;
  event: string;
  data: any;
}

/** Minimal SSE client over fetch: collects events until `until` returns true or timeout. */
async function collect(url: string, headers: Record<string, string>, until: (evs: SseEvent[]) => boolean, timeoutMs = 5000): Promise<SseEvent[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const events: SseEvent[] = [];
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev: SseEvent = { event: 'message', data: null };
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) ev.id = line.slice(4);
          else if (line.startsWith('event: ')) ev.event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (!data && !ev.id) continue; // comments / retry
        ev.data = data ? JSON.parse(data) : null;
        events.push(ev);
      }
      if (until(events)) break;
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return events;
}

describe('SSE change feed', () => {
  let env: TestEnv;
  let env2: TestEnv;
  let base: string;
  let base2: string;
  let owner: { id: string; cookie: string };
  let pid: string;

  beforeAll(async () => {
    env = await TestEnv.create();
    await env.app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(env.app.server.address() as { port: number }).port}`;
    // Second server instance on the same database.
    env2 = await TestEnv.create({ dbUrl: env.dbUrl });
    await env2.app.listen({ host: '127.0.0.1', port: 0 });
    base2 = `http://127.0.0.1:${(env2.app.server.address() as { port: number }).port}`;
    owner = await env.user('owner@example.com');
    pid = (await env.req('POST', '/api/projects', { cookie: owner.cookie, body: { name: 'Live' } })).body.id;
  });
  afterAll(async () => {
    await env2?.app.close();
    await env?.close();
  });

  const save = (path: string, baseVersion?: number) =>
    env.req('PUT', `/api/projects/${pid}/scripts/${path}`, { cookie: owner.cookie, body: { source: VALID_SCRIPT.replace('/dashboard', `/${path}${baseVersion ?? 0}`), ...(baseVersion ? { baseVersion } : {}) } });

  it('streams live changes with id = per-project sequence', async () => {
    const p = collect(`${base}/api/projects/${pid}/events`, { cookie: owner.cookie }, (evs) => evs.filter((e) => e.event === 'change').length >= 2);
    await new Promise((r) => setTimeout(r, 300));
    await save('a.yaml');
    await save('b.yaml');
    const evs = await p;
    expect(evs[0]!.event).toBe('ready');
    const changes = evs.filter((e) => e.event === 'change');
    expect(changes.map((e) => e.data.kind)).toEqual(['script.created', 'script.created']);
    expect(changes.map((e) => Number(e.id))).toEqual([Number(evs[0]!.id) + 1, Number(evs[0]!.id) + 2]);
    expect(changes[0]!.data).toMatchObject({ seq: Number(changes[0]!.id), actorId: owner.id, data: { targetType: 'script', path: 'a.yaml' } });
  });

  it('resumes after Last-Event-ID (header) with exactly the missed events', async () => {
    const ready = await collect(`${base}/api/projects/${pid}/events`, { cookie: owner.cookie }, (evs) => evs.some((e) => e.event === 'ready'));
    const last = Number(ready[0]!.id);
    // Disconnected meanwhile: three changes happen.
    await save('c.yaml');
    await save('c.yaml', 1);
    await env.req('POST', `/api/projects/${pid}/scripts/c.yaml/rename`, { cookie: owner.cookie, body: { newPath: 'd.yaml' } });
    const evs = await collect(`${base}/api/projects/${pid}/events`, { cookie: owner.cookie, 'last-event-id': String(last) }, (e) => e.filter((x) => x.event === 'change').length >= 3);
    const changes = evs.filter((e) => e.event === 'change');
    expect(changes.map((e) => Number(e.id))).toEqual([last + 1, last + 2, last + 3]);
    expect(changes.map((e) => e.data.kind)).toEqual(['script.created', 'script.saved', 'script.renamed']);
  });

  it('query fallback ?lastEventId= works too, and nothing is duplicated', async () => {
    const r = await collect(`${base}/api/projects/${pid}/events`, { cookie: owner.cookie }, (evs) => evs.some((e) => e.event === 'ready'));
    const last = Number(r[0]!.id);
    await save('q.yaml');
    const evs = await collect(`${base}/api/projects/${pid}/events?lastEventId=${last - 1}`, { cookie: owner.cookie }, (e) => e.filter((x) => x.event === 'change').length >= 2, 1500);
    const ids = evs.filter((e) => e.event === 'change').map((e) => Number(e.id));
    expect(ids).toEqual([last, last + 1]);
  });

  it('signals a full resync when the requested position was purged', async () => {
    const r = await collect(`${base}/api/projects/${pid}/events`, { cookie: owner.cookie }, (evs) => evs.some((e) => e.event === 'ready'));
    const last = Number(r[0]!.id);
    // Simulate retention: everything up to `last` is gone.
    await env.ctx.db.delete(changeFeed);
    await save('after-purge.yaml');
    const evs = await collect(`${base}/api/projects/${pid}/events`, { cookie: owner.cookie, 'last-event-id': '1' }, (e) => e.length >= 1);
    expect(evs[0]!.event).toBe('resync');
    expect(Number(evs[0]!.id)).toBe(last + 1);
    // Resuming from the newest retained position does not resync.
    const ok = await collect(`${base}/api/projects/${pid}/events`, { cookie: owner.cookie, 'last-event-id': String(last) }, (e) => e.some((x) => x.event === 'change'));
    expect(ok[0]!.event).toBe('ready');
    expect(ok.find((e) => e.event === 'change')!.data.kind).toBe('script.created');
  });

  it('a change made through server A reaches a client connected to server B (LISTEN/NOTIFY)', async () => {
    const p = collect(`${base2}/api/projects/${pid}/events`, { cookie: owner.cookie }, (evs) => evs.some((e) => e.event === 'change'));
    await new Promise((r) => setTimeout(r, 300));
    await env.req('PATCH', `/api/projects/${pid}`, { cookie: owner.cookie, body: { description: 'from A' } });
    const evs = await p;
    expect(evs.find((e) => e.event === 'change')!.data.kind).toBe('project.updated');
  });

  it('requires view permission (401 without auth, 404 for unknown project)', async () => {
    expect((await fetch(`${base}/api/projects/${pid}/events`)).status).toBe(401);
    expect((await fetch(`${base}/api/projects/nope/events`, { headers: { cookie: owner.cookie } })).status).toBe(404);
  });
});
