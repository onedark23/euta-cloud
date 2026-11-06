// Scripts + versions (SPEC 스크립트). Save needs the base version (409 on mismatch), must pass
// engine validation (422) except origin `external`, and is limited to 256 KiB. Paths travel in
// the URL wildcard; `/versions`, `/versions/:n`, `/rename`, `/restore`, `/revert` suffixes are
// unambiguous because script paths must end in .yaml/.yml.
import {
  SCRIPT_MAX_BYTES,
  scriptCheckSchema,
  scriptPutSchema,
  scriptRenameSchema,
  scriptRevertSchema,
  TRASH_RETENTION_DAYS,
  type ScriptCheckDto,
} from '@euta-cloud/shared';
import { osInputIssues, parseYaml, rewriteScript, scriptHash, secretNamesOf, secretPlacementIssues, type ScriptEdit } from '@euta/core';
import { describeStep } from '@euta/core/describe';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DAY_MS } from '../clock.js';
import type { AppContext } from '../context.js';
import { credentials, environments, scripts, scriptVersions, users } from '../db/schema.js';
import { AppError, notFound, parse } from '../http.js';
import { actorOf, projectAccess } from '../services/access.js';
import { record } from '../services/activity.js';
import { checkScript } from '../services/script-check.js';
import {
  addScriptVersion,
  isUniqueViolation,
  listScriptRows,
  liveScript as loadLiveScript,
  saveScript,
  scriptConflict,
  scriptDto,
  scriptPathOf,
  versionDto,
} from '../services/scripts.js';

type WildP = { Params: { id: string; '*': string } };

/** Split `<path>[/versions[/n]|/rename|/restore|/revert]`. */
function splitWildcard(raw: string): { path: string; suffix: string | null; n?: number } {
  const m = /^(.+\.ya?ml)\/(versions(?:\/(\d+))?|rename|restore|revert)$/i.exec(raw);
  if (!m) return { path: raw, suffix: null };
  const suffix = m[2]!.startsWith('versions') ? 'versions' : m[2]!.toLowerCase();
  return { path: m[1]!, suffix, ...(m[3] ? { n: Number(m[3]) } : {}) };
}

export async function scriptRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, feed } = ctx;
  const base = '/api/projects/:id/scripts';
  const listRows = (projectId: string, where: ReturnType<typeof and>) => listScriptRows(db, projectId, where);
  const liveScript = (projectId: string, path: string) => loadLiveScript(db, projectId, path);

  // ── List
  app.get<{ Params: { id: string }; Querystring: { deleted?: string } }>(base, async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const deleted = req.query.deleted === '1' || req.query.deleted === 'true';
    const rows = await listRows(project.id, deleted ? isNotNull(scripts.deletedAt) : isNull(scripts.deletedAt));
    return { scripts: rows.map((r) => scriptDto(r.s, r.v, r.authorName)) };
  });

  // ── Check (no save): validate a text, or apply a form edit to a base text first. Read-only, so
  // anyone who can view the project may use it (the web renders YAML → step sentences with it).
  app.post<{ Params: { id: string } }>(`${base}/check`, async (req): Promise<ScriptCheckDto> => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const body = parse(scriptCheckSchema, req.body);
    let source: string;
    if (body.edit) {
      try {
        source = rewriteScript(body.base!, body.edit as ScriptEdit);
      } catch (e) {
        throw new AppError(422, 'VALIDATION_FAILED', `the edit could not be applied: ${(e as Error).message}`);
      }
    } else source = body.source!;
    if (Buffer.byteLength(source, 'utf8') > SCRIPT_MAX_BYTES) throw new AppError(422, 'SCRIPT_TOO_LARGE', `script must be at most ${SCRIPT_MAX_BYTES / 1024} KiB`);
    const check = checkScript(source);
    const value = check.parsed ? parseYaml(source).value : undefined;
    const script = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    const secretNames = script ? secretNamesOf(script) : [];
    let missingSecrets: string[] = [];
    if (body.environmentId) {
      const [env] = await db.select({ id: environments.id }).from(environments).where(and(eq(environments.id, body.environmentId), eq(environments.projectId, project.id)));
      if (!env) throw notFound('environment');
      const have = new Set((await db.select({ name: credentials.name }).from(credentials).where(eq(credentials.environmentId, env.id))).map((c) => c.name));
      missingSecrets = secretNames.filter((n) => !have.has(n));
    }
    const steps = script && Array.isArray(script.steps) ? (script.steps as unknown[]) : [];
    return {
      source,
      contentHash: scriptHash(source),
      script,
      validation: { parsed: check.parsed, ok: check.ok, issues: check.issues },
      secretNames,
      missingSecrets,
      ruleIssues: script ? secretPlacementIssues(script) : [],
      osInputIssues: script ? osInputIssues(script as Parameters<typeof osInputIssues>[0]) : [],
      unstable: steps.reduce<number>((n, s) => n + describeStep(s).unstable, 0),
    };
  });

  // ── Read: script · versions · one version
  app.get<WildP>(`${base}/*`, async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const { path, suffix, n } = splitWildcard(req.params['*']);
    if (suffix && suffix !== 'versions') throw notFound('route');
    const row = await liveScript(project.id, scriptPathOf(path));
    if (suffix === 'versions') {
      const where = n !== undefined ? and(eq(scriptVersions.scriptId, row.s.id), eq(scriptVersions.version, n)) : eq(scriptVersions.scriptId, row.s.id);
      const vs = await db
        .select({ v: scriptVersions, authorName: users.name })
        .from(scriptVersions)
        .leftJoin(users, eq(users.id, scriptVersions.authorId))
        .where(where)
        .orderBy(desc(scriptVersions.version));
      const author = (x: (typeof vs)[number]) => (x.v.authorId ? { id: x.v.authorId, name: x.authorName ?? '' } : null);
      if (n !== undefined) {
        if (!vs[0]) throw notFound('version');
        return versionDto(vs[0].v, author(vs[0]), true);
      }
      return { versions: vs.map((x) => versionDto(x.v, author(x))) };
    }
    return { ...scriptDto(row.s, row.v, row.authorName), source: row.v.source, validation: { ok: row.v.validationOk, issues: row.v.validationIssues } };
  });

  // ── Save
  app.put<WildP>(`${base}/*`, async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'script.edit');
    const path = scriptPathOf(req.params['*']);
    const body = parse(scriptPutSchema, req.body);
    const out = await saveScript(ctx, principal, project, path, body);
    reply.status(out.created ? 201 : 200);
    return { script: out.script, version: out.version, unchanged: out.unchanged };
  });

  // ── Delete (soft)
  app.delete<WildP>(`${base}/*`, async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'script.edit');
    const path = scriptPathOf(req.params['*']);
    await db.transaction(async (tx) => {
      const [s] = await tx
        .update(scripts)
        .set({ deletedAt: ctx.clock.now(), deletedBy: principal.user.id })
        .where(and(eq(scripts.projectId, project.id), eq(scripts.path, path), isNull(scripts.deletedAt)))
        .returning();
      if (!s) throw notFound('script');
      await record(tx, feed, actorOf(principal), { projectId: project.id, kind: 'script.deleted', summary: `스크립트 삭제: ${path}`, targetType: 'script', targetId: s.id, details: { path } });
    });
    return reply.status(204).send();
  });

  // ── rename · restore · revert
  app.post<WildP>(`${base}/*`, async (req: FastifyRequest<WildP>) => {
    const { path: rawPath, suffix } = splitWildcard(req.params['*']);
    if (!suffix || suffix === 'versions') throw notFound('route');
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'script.edit');
    const path = scriptPathOf(rawPath);
    const actor = actorOf(principal);

    if (suffix === 'rename') {
      const { newPath } = parse(scriptRenameSchema, req.body);
      try {
        const s = await db.transaction(async (tx) => {
          const [s] = await tx.select().from(scripts).where(and(eq(scripts.projectId, project.id), eq(scripts.path, path), isNull(scripts.deletedAt))).for('update');
          if (!s) throw notFound('script');
          const [taken] = await tx.select({ id: scripts.id }).from(scripts).where(and(eq(scripts.projectId, project.id), eq(scripts.path, newPath), isNull(scripts.deletedAt)));
          if (taken) throw new AppError(409, 'NAME_TAKEN', `a script already exists at ${newPath}`);
          const [u] = await tx.update(scripts).set({ path: newPath, updatedAt: ctx.clock.now() }).where(eq(scripts.id, s.id)).returning();
          await record(tx, feed, actor, { projectId: project.id, kind: 'script.renamed', summary: `스크립트 이름 변경: ${path} → ${newPath}`, targetType: 'script', targetId: s.id, details: { from: path, to: newPath } });
          return u!;
        });
        const row = await liveScript(project.id, s.path);
        return scriptDto(row.s, row.v, row.authorName);
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(409, 'NAME_TAKEN', `a script already exists at ${newPath}`);
        throw e;
      }
    }

    if (suffix === 'restore') {
      const cutoff = new Date(ctx.clock.now().getTime() - TRASH_RETENTION_DAYS * DAY_MS);
      try {
        const s = await db.transaction(async (tx) => {
          const [s] = await tx
            .select()
            .from(scripts)
            .where(and(eq(scripts.projectId, project.id), eq(scripts.path, path), isNotNull(scripts.deletedAt)))
            .orderBy(desc(scripts.deletedAt))
            .limit(1)
            .for('update');
          if (!s || !s.deletedAt || s.deletedAt.getTime() < cutoff.getTime()) throw notFound('deleted script');
          const [taken] = await tx.select({ id: scripts.id }).from(scripts).where(and(eq(scripts.projectId, project.id), eq(scripts.path, path), isNull(scripts.deletedAt)));
          if (taken) throw new AppError(409, 'NAME_TAKEN', `a script already exists at ${path} — rename it first`);
          const [u] = await tx.update(scripts).set({ deletedAt: null, deletedBy: null, updatedAt: ctx.clock.now() }).where(eq(scripts.id, s.id)).returning();
          await record(tx, feed, actor, { projectId: project.id, kind: 'script.restored', summary: `스크립트 복원: ${path}`, targetType: 'script', targetId: s.id, details: { path } });
          return u!;
        });
        const row = await liveScript(project.id, s.path);
        return scriptDto(row.s, row.v, row.authorName);
      } catch (e) {
        if (isUniqueViolation(e)) throw new AppError(409, 'NAME_TAKEN', `a script already exists at ${path}`);
        throw e;
      }
    }

    // revert: the old text becomes a new version (history is kept).
    const body = parse(scriptRevertSchema, req.body);
    const out = await db.transaction(async (tx) => {
      const [s] = await tx.select().from(scripts).where(and(eq(scripts.projectId, project.id), eq(scripts.path, path), isNull(scripts.deletedAt))).for('update');
      if (!s) throw notFound('script');
      if (body.baseVersion !== undefined && body.baseVersion !== s.currentVersion) throw await scriptConflict(tx, s);
      const [old] = await tx.select().from(scriptVersions).where(and(eq(scriptVersions.scriptId, s.id), eq(scriptVersions.version, body.version)));
      if (!old) throw notFound('version');
      const check = checkScript(old.source);
      const r = await addScriptVersion(ctx, tx, s, principal, old.source, 'revert', body.memo ?? `v${body.version} 로 되돌리기`, check, body.version);
      await record(tx, feed, actor, {
        projectId: project.id,
        kind: 'script.reverted',
        summary: `스크립트 되돌리기: ${path} v${body.version} → v${r.version.version}`,
        targetType: 'script',
        targetId: s.id,
        details: { path, from: body.version, version: r.version.version },
      });
      return r;
    });
    return {
      script: scriptDto(out.script, out.version, principal.user.name),
      version: versionDto(out.version, { id: principal.user.id, name: principal.user.name }),
    };
  });
}
