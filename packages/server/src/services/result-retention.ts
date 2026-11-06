// Result file retention (SPEC 결과 보관, ADR-021 §2): files older than RESULT_RETENTION_DAYS (30) go,
// then the oldest runs' files until the total is under RESULT_MAX_TOTAL (12Gi). The DB row (summary,
// steps, metrics, expect results) stays and is marked `expired`. Baselines are never touched.
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { DAY_MS } from '../clock.js';
import type { AppContext } from '../context.js';
import { runs } from '../db/schema.js';

export async function purgeResults(ctx: AppContext): Promise<{ expiredByAge: number; expiredBySize: number; totalBytes: number }> {
  const now = ctx.clock.now().getTime();
  const cutoff = new Date(now - ctx.config.resultRetentionDays * DAY_MS);
  const expire = async (r: { id: string; projectId: string }) => {
    await ctx.results.deleteRun(r.projectId, r.id);
    await ctx.db.update(runs).set({ resultFiles: 'expired', resultBytes: 0 }).where(eq(runs.id, r.id));
  };
  const old = await ctx.db
    .select({ id: runs.id, projectId: runs.projectId })
    .from(runs)
    .where(and(eq(runs.resultFiles, 'present'), lt(runs.finishedAt, cutoff)));
  for (const r of old) await expire(r);

  let expiredBySize = 0;
  const [{ total } = { total: 0 }] = await ctx.db
    .select({ total: sql<string>`coalesce(sum(${runs.resultBytes}), 0)` })
    .from(runs)
    .where(eq(runs.resultFiles, 'present'));
  let totalBytes = Number(total);
  if (totalBytes > ctx.config.resultMaxTotalBytes) {
    const candidates = await ctx.db
      .select({ id: runs.id, projectId: runs.projectId, bytes: runs.resultBytes })
      .from(runs)
      .where(eq(runs.resultFiles, 'present'))
      .orderBy(asc(runs.finishedAt), asc(runs.createdAt));
    for (const r of candidates) {
      if (totalBytes <= ctx.config.resultMaxTotalBytes) break;
      await expire(r);
      totalBytes -= r.bytes;
      expiredBySize++;
    }
  }
  return { expiredByAge: old.length, expiredBySize, totalBytes };
}
