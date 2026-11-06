// Periodic cleanup: trash (projects · scripts) after 30 days, activity after 1 year, change feed
// after FEED_RETENTION_DAYS. Uses the injectable clock so tests can jump past the window.
import { TRASH_RETENTION_DAYS } from '@euta-cloud/shared';
import { and, isNotNull, isNull, lt } from 'drizzle-orm';
import { DAY_MS } from '../clock.js';
import type { AppContext } from '../context.js';
import { activity, projects, runs, scripts } from '../db/schema.js';
import { purgeUserEvents } from './user-events.js';
import { expireAccessRequests } from '../routes/access.js';

export const ACTIVITY_RETENTION_DAYS = 365;
/** SPEC 결과 보관: run summary · steps · metrics · expect results (DB) are kept 1 year. */
export const RUN_RETENTION_DAYS = 365;

export async function purgeExpired(ctx: AppContext): Promise<{ projects: number; scripts: number; activity: number; feed: number; runs: number; userEvents: number }> {
  const now = ctx.clock.now().getTime();
  const trashCutoff = new Date(now - TRASH_RETENTION_DAYS * DAY_MS);
  // Cascades: members · environments · credentials · scripts · versions · suites · runs · activity · feed.
  const p = await ctx.db.delete(projects).where(and(isNotNull(projects.deletedAt), lt(projects.deletedAt, trashCutoff))).returning({ id: projects.id });
  // Result files and baselines of purged projects (SPEC 삭제 "결과 파일 영구 삭제").
  for (const { id } of p) await ctx.results.deleteProject(id);
  const s = await ctx.db.delete(scripts).where(and(isNotNull(scripts.deletedAt), lt(scripts.deletedAt, trashCutoff)));
  const a = await ctx.db.delete(activity).where(lt(activity.at, new Date(now - ACTIVITY_RETENTION_DAYS * DAY_MS)));
  const f = await ctx.feed.purgeOlderThan(new Date(now - ctx.config.feedRetentionDays * DAY_MS));
  // App notification events: same retention as the change feed (older resumes get `resync`).
  const ue = await purgeUserEvents(ctx.db, new Date(now - ctx.config.feedRetentionDays * DAY_MS));
  // Open access requests past 30 days → expired (also done lazily on read).
  await expireAccessRequests(ctx.db, new Date(now));
  // Top-level runs older than a year (suite children cascade), with any files still on disk.
  const oldRuns = await ctx.db
    .delete(runs)
    .where(and(isNull(runs.parentRunId), isNotNull(runs.finishedAt), lt(runs.finishedAt, new Date(now - RUN_RETENTION_DAYS * DAY_MS))))
    .returning({ id: runs.id, projectId: runs.projectId });
  for (const r of oldRuns) await ctx.results.deleteRun(r.projectId, r.id);
  return { runs: oldRuns.length, projects: p.length, scripts: s.rowCount ?? 0, activity: a.rowCount ?? 0, feed: f, userEvents: ue };
}
