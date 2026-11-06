// App notification events (`GET /api/me/events`, SPEC_클라우드-앱-연동 "앱 알림"). One row per
// recipient with a global bigserial id = SSE event id. Inserts take a transaction advisory lock so
// rows become visible in id order (a reader resuming after id N never misses a lower id committed
// later). Callers insert as the LAST statement of their transaction (the lock is held to commit).
import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/index.js';
import { userEvents } from '../db/schema.js';

export const USER_EVENTS_CHANNEL = 'euta_user_events';

export interface UserEventInsert {
  userId: string;
  projectId: string;
  runId: string | null;
  kind: string;
  data: Record<string, unknown>;
  at: Date;
}

export async function insertUserEvents(tx: DbOrTx, rows: UserEventInsert[]): Promise<void> {
  if (!rows.length) return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('euta_user_events'))`);
  await tx.insert(userEvents).values(rows);
  await tx.execute(sql`select pg_notify(${USER_EVENTS_CHANNEL}, '')`);
}

export type UserEventRow = typeof userEvents.$inferSelect;

export async function userEventsSince(db: Db, userId: string, afterId: number, limit = 500): Promise<UserEventRow[]> {
  return db
    .select()
    .from(userEvents)
    .where(and(eq(userEvents.userId, userId), gt(userEvents.id, afterId)))
    .orderBy(asc(userEvents.id))
    .limit(limit);
}

/**
 * Oldest retained id (any user — purging goes by age, so everything below it is gone) and the newest
 * committed id. (Not the sequence value: under the insert lock a not-yet-committed row may already
 * hold the next id, and a reader starting there would skip it.)
 */
export async function userEventBounds(db: Db): Promise<{ minId: number | null; lastId: number }> {
  const res = await db.execute<{ min_id: string | null; last_id: string | null }>(
    sql`select (select min(id) from user_events) as min_id, (select max(id) from user_events) as last_id`,
  );
  const r = res.rows[0];
  return { minId: r?.min_id == null ? null : Number(r.min_id), lastId: Number(r?.last_id ?? 0) };
}

export async function purgeUserEvents(db: Db, cutoff: Date): Promise<number> {
  const res = await db.delete(userEvents).where(lt(userEvents.at, cutoff));
  return res.rowCount ?? 0;
}
