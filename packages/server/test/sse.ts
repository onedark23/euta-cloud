// Minimal SSE client over fetch for tests (same parser as events.test.ts).
import { expect } from 'vitest';

export interface SseEvent {
  id?: string;
  event: string;
  data: any;
}

/** Minimal SSE client over fetch: collects events until `until` returns true or timeout. */
export async function collect(url: string, headers: Record<string, string>, until: (evs: SseEvent[]) => boolean, timeoutMs = 5000): Promise<SseEvent[]> {
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
