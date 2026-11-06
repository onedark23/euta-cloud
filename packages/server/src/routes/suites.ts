// Suites (SPEC 테스트 세트 — 내부 이름 suite): name · ordered script list (script ids, survive renames) ·
// "항상 실행" script ids (ADR-031) · default env.
import { suiteCreateSchema, suiteUpdateSchema } from '@euta-cloud/shared';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { Db } from '../db/index.js';
import { environments, scripts, suites } from '../db/schema.js';
import { AppError, notFound, parse } from '../http.js';
import { actorOf, projectAccess } from '../services/access.js';
import { record } from '../services/activity.js';

type SuiteRow = typeof suites.$inferSelect;
type SuiteP = { Params: { id: string; suiteId: string } };

const scriptPathsOf = async (db: Db, projectId: string) => {
  const rows = await db.select({ id: scripts.id, path: scripts.path }).from(scripts).where(and(eq(scripts.projectId, projectId), isNull(scripts.deletedAt)));
  return new Map(rows.map((r) => [r.id, r.path]));
};

export const suiteDto = (s: SuiteRow, paths: Map<string, string>) => ({
  id: s.id,
  name: s.name,
  scripts: s.scriptIds.map((id) => ({ id, path: paths.get(id) ?? null })),
  alwaysRun: s.alwaysRun,
  defaultEnvironmentId: s.defaultEnvironmentId,
  updatedAt: s.updatedAt.toISOString(),
});

/** Suites of a project (REST list + remote MCP `get_project`). */
export async function suiteList(ctx: AppContext, projectId: string) {
  const rows = await ctx.db.select().from(suites).where(eq(suites.projectId, projectId)).orderBy(asc(suites.name));
  const paths = await scriptPathsOf(ctx.db, projectId);
  return rows.map((r) => suiteDto(r, paths));
}

export async function suiteRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, feed } = ctx;

  const scriptPaths = (projectId: string) => scriptPathsOf(db, projectId);
  const dto = suiteDto;

  /** "항상 실행" ids must be items of the suite (an old client sending only scriptIds keeps the marks that still apply). */
  const alwaysRunFor = (scriptIds: string[], alwaysRun: string[]) => {
    const bad = alwaysRun.filter((id) => !scriptIds.includes(id));
    if (bad.length) throw new AppError(422, 'VALIDATION_FAILED', 'always-run scripts must be in the suite', bad.map((id) => ({ path: 'alwaysRun', message: `not in scriptIds: ${id}` })));
    return [...new Set(alwaysRun)];
  };

  const validateRefs = async (projectId: string, scriptIds?: string[], envId?: string | null) => {
    if (scriptIds?.length) {
      const found = await db
        .select({ id: scripts.id })
        .from(scripts)
        .where(and(eq(scripts.projectId, projectId), isNull(scripts.deletedAt), inArray(scripts.id, scriptIds)));
      const ok = new Set(found.map((f) => f.id));
      const bad = scriptIds.filter((id) => !ok.has(id));
      if (bad.length) throw new AppError(422, 'VALIDATION_FAILED', 'unknown scripts in suite', bad.map((id) => ({ path: 'scriptIds', message: `unknown script ${id}` })));
    }
    if (envId) {
      const [e] = await db.select({ id: environments.id }).from(environments).where(and(eq(environments.id, envId), eq(environments.projectId, projectId)));
      if (!e) throw new AppError(422, 'VALIDATION_FAILED', 'unknown environment', [{ path: 'defaultEnvironmentId', message: 'unknown environment' }]);
    }
  };

  app.get<{ Params: { id: string } }>('/api/projects/:id/suites', async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    return { suites: await suiteList(ctx, project.id) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/suites', async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'suite.edit');
    const body = parse(suiteCreateSchema, req.body);
    await validateRefs(project.id, body.scriptIds, body.defaultEnvironmentId);
    const row = await db.transaction(async (tx) => {
      const [s] = await tx
        .insert(suites)
        .values({ projectId: project.id, name: body.name, scriptIds: body.scriptIds, alwaysRun: alwaysRunFor(body.scriptIds, body.alwaysRun), defaultEnvironmentId: body.defaultEnvironmentId ?? null, updatedBy: principal.user.id })
        .returning();
      await record(tx, feed, actorOf(principal), { projectId: project.id, kind: 'suite.created', summary: `테스트 세트 만들기: ${body.name}`, targetType: 'suite', targetId: s!.id });
      return s!;
    });
    reply.status(201);
    return dto(row, await scriptPaths(project.id));
  });

  app.patch<SuiteP>('/api/projects/:id/suites/:suiteId', async (req) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'suite.edit');
    const body = parse(suiteUpdateSchema, req.body);
    await validateRefs(project.id, body.scriptIds, body.defaultEnvironmentId);
    const row = await db.transaction(async (tx) => {
      let alwaysRun: string[] | undefined;
      if (body.scriptIds !== undefined || body.alwaysRun !== undefined) {
        const [cur] = await tx.select().from(suites).where(and(eq(suites.id, req.params.suiteId), eq(suites.projectId, project.id))).for('update');
        if (!cur) throw notFound('suite');
        const ids = body.scriptIds ?? cur.scriptIds;
        alwaysRun = body.alwaysRun !== undefined ? alwaysRunFor(ids, body.alwaysRun) : cur.alwaysRun.filter((id) => ids.includes(id));
      }
      const [s] = await tx
        .update(suites)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.scriptIds !== undefined ? { scriptIds: body.scriptIds } : {}),
          ...(alwaysRun !== undefined ? { alwaysRun } : {}),
          ...(body.defaultEnvironmentId !== undefined ? { defaultEnvironmentId: body.defaultEnvironmentId } : {}),
          updatedAt: ctx.clock.now(),
          updatedBy: principal.user.id,
        })
        .where(and(eq(suites.id, req.params.suiteId), eq(suites.projectId, project.id)))
        .returning();
      if (!s) throw notFound('suite');
      await record(tx, feed, actorOf(principal), { projectId: project.id, kind: 'suite.updated', summary: `테스트 세트 변경: ${s.name}`, targetType: 'suite', targetId: s.id });
      return s;
    });
    return dto(row, await scriptPaths(project.id));
  });

  app.delete<SuiteP>('/api/projects/:id/suites/:suiteId', async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'suite.edit');
    await db.transaction(async (tx) => {
      const [s] = await tx.delete(suites).where(and(eq(suites.id, req.params.suiteId), eq(suites.projectId, project.id))).returning();
      if (!s) throw notFound('suite');
      await record(tx, feed, actorOf(principal), { projectId: project.id, kind: 'suite.deleted', summary: `테스트 세트 삭제: ${s.name}`, targetType: 'suite', targetId: s.id });
    });
    return reply.status(204).send();
  });
}
