// Per-project daily run cap (PLAN 결정 "실사용 부작용"): script runs created per Asia/Seoul calendar
// day — scheduled, requested (web/app), MCP and retries. Local uploads and skipped records do not
// count; a suite counts one per script. Callers check inside the inserting transaction after
// locking the project row, so concurrent requests cannot both pass the last free slot.
import { and, count, eq, gte, ne, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { runs } from '../db/schema.js';
import { AppError } from '../http.js';

/** Korea has had no DST since 1988 — the Seoul day is a fixed UTC+9 window. */
const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Start of the Asia/Seoul calendar day containing `now`, and its date label (YYYY-MM-DD). */
export function seoulDay(now: Date): { start: Date; day: string } {
  const local = now.getTime() + SEOUL_OFFSET_MS;
  const startLocal = Math.floor(local / DAY_MS) * DAY_MS;
  return { start: new Date(startLocal - SEOUL_OFFSET_MS), day: new Date(startLocal).toISOString().slice(0, 10) };
}

export async function dailyUsage(db: DbOrTx, projectId: string, now: Date): Promise<{ day: string; used: number }> {
  const { start, day } = seoulDay(now);
  const [r] = await db
    .select({ n: count() })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), eq(runs.kind, 'script'), ne(runs.source, 'local_upload'), ne(runs.status, 'skipped'), gte(runs.createdAt, start)));
  return { day, used: Number(r?.n ?? 0) };
}

/** Lock the project row (serializes cap checks) and tell whether `n` more script runs fit today. */
export async function capRoom(tx: DbOrTx, projectId: string, cap: number, now: Date, n: number): Promise<{ ok: boolean; day: string; used: number; cap: number }> {
  await tx.execute(sql`select id from projects where id = ${projectId} for update`);
  const u = await dailyUsage(tx, projectId, now);
  return { ok: u.used + n <= cap, ...u, cap };
}

export function capReached(room: { day: string; used: number; cap: number }): AppError {
  return new AppError(422, 'DAILY_RUN_CAP_REACHED', `the project's daily run cap is reached (${room.used}/${room.cap} today, Asia/Seoul)`, { cap: room.cap, used: room.used, day: room.day });
}
