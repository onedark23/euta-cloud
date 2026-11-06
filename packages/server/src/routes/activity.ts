// Activity log (SPEC 작업 로그): newest first, filter by kind (prefix, e.g. "script") and actor.
import { activityQuerySchema } from '@euta-cloud/shared';
import { and, desc, eq, like, lt, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { activity } from '../db/schema.js';
import { parse } from '../http.js';
import { projectAccess } from '../services/access.js';

export async function activityRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get<{ Params: { id: string } }>('/api/projects/:id/activity', async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const q = parse(activityQuerySchema, req.query);
    const rows = await ctx.db
      .select()
      .from(activity)
      .where(
        and(
          eq(activity.projectId, project.id),
          q.kind ? or(eq(activity.kind, q.kind), like(activity.kind, `${q.kind.replace(/[%_\\]/g, '')}.%`)) : undefined,
          q.actor ? (['user', 'ai', 'schedule', 'system'].includes(q.actor) ? eq(activity.actorType, q.actor) : eq(activity.actorId, q.actor)) : undefined,
          q.before ? lt(activity.id, q.before) : undefined,
        ),
      )
      .orderBy(desc(activity.id))
      .limit(q.limit);
    return {
      entries: rows.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        actor: { type: r.actorType, id: r.actorId, label: r.actorLabel },
        kind: r.kind,
        target: r.targetType ? { type: r.targetType, id: r.targetId } : null,
        summary: r.summary,
        details: r.details,
      })),
      nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.id : null,
    };
  });
}
