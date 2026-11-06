// Per-project change feed (ADR-020 §4, ADR-022): every change gets a per-project increasing `seq`
// in the same transaction as the change; `NOTIFY euta_feed '{p,s}'` fans out to every server
// instance (delivered on commit), each of which re-reads rows > last sent for its SSE clients.
import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import type { Db, DbOrTx } from '../db/index.js';
import { changeFeed, projects } from '../db/schema.js';

export const FEED_CHANNEL = 'euta_feed';
/** Run queue wake-up (ADR-020 §2): a run became claimable (new run, or a run finished and unblocked others). */
export const RUNS_CHANNEL = 'euta_runs';
/** Other wake-up channels (payload ignored): app notification events, Teams outbox. */
export const SIGNAL_CHANNELS = ['euta_user_events', 'euta_notify'] as const;
export type SignalChannel = (typeof SIGNAL_CHANNELS)[number];

export interface FeedRow {
  seq: number;
  kind: string;
  at: Date;
  actorId: string | null;
  data: Record<string, unknown>;
}

type Listener = (seq: number) => void;

export class ChangeFeed {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly runListeners = new Set<() => void>();
  private readonly signalListeners = new Map<string, Set<() => void>>();
  private client: pg.Client | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly databaseUrl: string,
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Open the dedicated LISTEN connection (reconnects on failure). */
  async start(): Promise<void> {
    this.stopped = false;
    const client = new pg.Client({ connectionString: this.databaseUrl });
    client.on('notification', (msg) => {
      if (msg.channel === RUNS_CHANNEL) {
        for (const fn of [...this.runListeners]) fn();
        return;
      }
      const signal = this.signalListeners.get(msg.channel);
      if (signal) {
        for (const fn of [...signal]) fn();
        return;
      }
      if (msg.channel !== FEED_CHANNEL || !msg.payload) return;
      try {
        const { p, s } = JSON.parse(msg.payload) as { p: string; s: number };
        for (const fn of this.listeners.get(p) ?? []) fn(s);
      } catch {
        /* ignore malformed payloads */
      }
    });
    client.on('error', (err) => {
      this.log.warn({ err: { message: err.message } }, 'change feed listener error — reconnecting');
      this.scheduleReconnect();
    });
    await client.connect();
    await client.query(`LISTEN ${FEED_CHANNEL}`);
    await client.query(`LISTEN ${RUNS_CHANNEL}`);
    for (const ch of SIGNAL_CHANNELS) await client.query(`LISTEN ${ch}`);
    this.client = client;
  }

  private scheduleReconnect() {
    const old = this.client;
    this.client = null;
    old?.end().catch(() => {});
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch(() => this.scheduleReconnect());
    }, 1000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => {});
  }

  subscribe(projectId: string, fn: Listener): () => void {
    let set = this.listeners.get(projectId);
    if (!set) this.listeners.set(projectId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(projectId);
    };
  }

  /** Called on every run-queue wake-up from any server instance. */
  onRunsChanged(fn: () => void): () => void {
    this.runListeners.add(fn);
    return () => this.runListeners.delete(fn);
  }

  /** Called on every NOTIFY of a signal channel from any server instance. */
  onSignal(channel: SignalChannel, fn: () => void): () => void {
    let set = this.signalListeners.get(channel);
    if (!set) this.signalListeners.set(channel, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Wake runners waiting in a claim long-poll (delivered on commit). */
  async notifyRuns(tx: DbOrTx): Promise<void> {
    await tx.execute(sql`select pg_notify(${RUNS_CHANNEL}, '')`);
  }

  /** Append an event inside the caller's transaction; returns its seq. */
  async append(tx: DbOrTx, projectId: string, kind: string, actorId: string | null, data: Record<string, unknown>): Promise<number> {
    const [row] = await tx
      .update(projects)
      .set({ feedSeq: sql`${projects.feedSeq} + 1` })
      .where(eq(projects.id, projectId))
      .returning({ seq: projects.feedSeq });
    if (!row) throw new Error(`project ${projectId} not found for feed append`);
    await tx.insert(changeFeed).values({ projectId, seq: row.seq, kind, actorId, data });
    await tx.execute(sql`select pg_notify(${FEED_CHANNEL}, ${JSON.stringify({ p: projectId, s: row.seq })})`);
    return row.seq;
  }

  async since(projectId: string, afterSeq: number, limit = 500): Promise<FeedRow[]> {
    return this.db
      .select({ seq: changeFeed.seq, kind: changeFeed.kind, at: changeFeed.at, actorId: changeFeed.actorId, data: changeFeed.data })
      .from(changeFeed)
      .where(and(eq(changeFeed.projectId, projectId), gt(changeFeed.seq, afterSeq)))
      .orderBy(asc(changeFeed.seq))
      .limit(limit);
  }

  /** Oldest retained seq (null when none retained) and the last issued seq. */
  async bounds(projectId: string): Promise<{ minSeq: number | null; lastSeq: number }> {
    const [r] = await this.db.execute<{ min_seq: string | null; last_seq: string }>(
      sql`select (select min(seq) from change_feed where project_id = ${projectId}) as min_seq, (select feed_seq from projects where id = ${projectId}) as last_seq`,
    ).then((res) => res.rows);
    return { minSeq: r?.min_seq == null ? null : Number(r.min_seq), lastSeq: Number(r?.last_seq ?? 0) };
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    const res = await this.db.delete(changeFeed).where(lt(changeFeed.at, cutoff));
    return res.rowCount ?? 0;
  }
}
