// Environments + test credentials (SPEC 환경). Credential values are write-only: no endpoint, log
// line or activity entry ever contains them — only name, last change time and changer.
import { credentialNameSchema, credentialPutSchema, environmentCreateSchema, environmentUpdateSchema, type CredentialDto, type EnvironmentDto } from '@euta-cloud/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { credentials, environments, projects, users } from '../db/schema.js';
import { credentialAad, encryptSecret } from '../crypto.js';
import { AppError, notFound, parse } from '../http.js';
import { actorOf, projectAccess, type ProjectRow } from '../services/access.js';
import type { Db } from '../db/index.js';
import { record } from '../services/activity.js';
import { checkPublicAddress } from '../services/address-check.js';

type EnvRow = typeof environments.$inferSelect;
type EnvP = { Params: { id: string; envId: string } };
type CredP = { Params: { id: string; envId: string; name: string } };

const hostOf = (url: string) => new URL(url).hostname.toLowerCase();

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}

const credentialNamesOf = async (db: Db, envIds: string[]) => {
  const rows = envIds.length
    ? await db
        .select({ environmentId: credentials.environmentId, name: credentials.name })
        .from(credentials)
        .where(inArray(credentials.environmentId, envIds))
        .orderBy(asc(credentials.name))
    : [];
  const map = new Map<string, string[]>();
  for (const r of rows) map.set(r.environmentId, [...(map.get(r.environmentId) ?? []), r.name]);
  return map;
};

export const environmentDto = (e: EnvRow, defaultId: string | null, names: string[]): EnvironmentDto => ({
  id: e.id,
  name: e.name,
  baseUrl: e.baseUrl,
  vars: e.vars,
  allowedDomains: e.allowedDomains,
  cloudRunnable: e.cloudRunnable,
  addressCheck: e.cloudRunnable ? { public: true } : { public: false, ...(e.addressCheckReason ? { reason: e.addressCheckReason } : {}) },
  isDefault: e.id === defaultId,
  credentialNames: names,
  updatedAt: e.updatedAt.toISOString(),
});

/** Environments of a project with credential names only (REST list + remote MCP `get_project`). */
export async function environmentList(ctx: AppContext, project: ProjectRow): Promise<EnvironmentDto[]> {
  const rows = await ctx.db.select().from(environments).where(eq(environments.projectId, project.id)).orderBy(asc(environments.name));
  const names = await credentialNamesOf(ctx.db, rows.map((r) => r.id));
  return rows.map((r) => environmentDto(r, project.defaultEnvironmentId, names.get(r.id) ?? []));
}

export async function environmentRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, feed } = ctx;

  const credentialNames = (envIds: string[]) => credentialNamesOf(db, envIds);
  const dto = environmentDto;

  const loadEnv = async (projectId: string, envId: string) => {
    const [e] = await db.select().from(environments).where(and(eq(environments.id, envId), eq(environments.projectId, projectId)));
    if (!e) throw notFound('environment');
    return e;
  };

  app.get<{ Params: { id: string } }>('/api/projects/:id/environments', async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    return { environments: await environmentList(ctx, project) };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/environments', async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'environment.edit');
    const body = parse(environmentCreateSchema, req.body);
    const check = await checkPublicAddress(body.baseUrl, ctx.resolveHost);
    try {
      const created = await db.transaction(async (tx) => {
        const [e] = await tx
          .insert(environments)
          .values({
            projectId: project.id,
            name: body.name,
            baseUrl: body.baseUrl,
            vars: body.vars,
            allowedDomains: body.allowedDomains ?? [hostOf(body.baseUrl)],
            cloudRunnable: check.public,
            addressCheckReason: check.reason ?? null,
            updatedBy: principal.user.id,
          })
          .returning();
        if (body.makeDefault) await tx.update(projects).set({ defaultEnvironmentId: e!.id }).where(eq(projects.id, project.id));
        await record(tx, feed, actorOf(principal), {
          projectId: project.id,
          kind: 'environment.created',
          summary: `환경 추가: ${body.name}${check.public ? '' : ' (클라우드 실행 불가 주소)'}`,
          targetType: 'environment',
          targetId: e!.id,
        });
        return e!;
      });
      reply.status(201);
      return dto(created, body.makeDefault ? created.id : project.defaultEnvironmentId, []);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, 'NAME_TAKEN', `an environment named "${body.name}" already exists`);
      throw e;
    }
  });

  app.patch<EnvP>('/api/projects/:id/environments/:envId', async (req) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'environment.edit');
    const env = await loadEnv(project.id, req.params.envId);
    const body = parse(environmentUpdateSchema, req.body);
    const changes: Partial<typeof environments.$inferInsert> = {};
    if (body.name !== undefined) changes.name = body.name;
    if (body.vars !== undefined) changes.vars = body.vars;
    if (body.allowedDomains !== undefined) changes.allowedDomains = body.allowedDomains;
    if (body.baseUrl !== undefined && body.baseUrl !== env.baseUrl) {
      const check = await checkPublicAddress(body.baseUrl, ctx.resolveHost);
      changes.baseUrl = body.baseUrl;
      changes.cloudRunnable = check.public;
      changes.addressCheckReason = check.reason ?? null;
      // Keep the default allowed domain in step with the address unless it was customized.
      const oldHost = hostOf(env.baseUrl);
      if (body.allowedDomains === undefined && env.allowedDomains.length === 1 && env.allowedDomains[0] === oldHost) changes.allowedDomains = [hostOf(body.baseUrl)];
    }
    try {
      const updated = await db.transaction(async (tx) => {
        const [u] = await tx.update(environments).set({ ...changes, updatedAt: ctx.clock.now(), updatedBy: principal.user.id }).where(eq(environments.id, env.id)).returning();
        if (body.makeDefault === true) await tx.update(projects).set({ defaultEnvironmentId: env.id }).where(eq(projects.id, project.id));
        if (body.makeDefault === false && project.defaultEnvironmentId === env.id) await tx.update(projects).set({ defaultEnvironmentId: null }).where(eq(projects.id, project.id));
        await record(tx, feed, actorOf(principal), {
          projectId: project.id,
          kind: 'environment.updated',
          summary: `환경 변경: ${u!.name}`,
          targetType: 'environment',
          targetId: env.id,
          details: { fields: [...Object.keys(changes), ...(body.makeDefault !== undefined ? ['default'] : [])] },
        });
        return u!;
      });
      const defaultId = body.makeDefault === true ? env.id : body.makeDefault === false && project.defaultEnvironmentId === env.id ? null : project.defaultEnvironmentId;
      const names = await credentialNames([env.id]);
      return dto(updated, defaultId, names.get(env.id) ?? []);
    } catch (e) {
      if (isUniqueViolation(e)) throw new AppError(409, 'NAME_TAKEN', `an environment named "${body.name}" already exists`);
      throw e;
    }
  });

  app.delete<EnvP>('/api/projects/:id/environments/:envId', async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'environment.edit');
    const env = await loadEnv(project.id, req.params.envId);
    await db.transaction(async (tx) => {
      // Credentials go with the environment (FK cascade); schedules keep it unset and record an error run when due.
      await tx.delete(environments).where(eq(environments.id, env.id));
      if (project.defaultEnvironmentId === env.id) await tx.update(projects).set({ defaultEnvironmentId: null }).where(eq(projects.id, project.id));
      await record(tx, feed, actorOf(principal), { projectId: project.id, kind: 'environment.deleted', summary: `환경 삭제: ${env.name}`, targetType: 'environment', targetId: env.id });
    });
    return reply.status(204).send();
  });

  // ── Test credentials (names only out, values only in)
  app.get<EnvP>('/api/projects/:id/environments/:envId/credentials', async (req) => {
    const { project } = await projectAccess(ctx, req, req.params.id, 'project.view');
    const env = await loadEnv(project.id, req.params.envId);
    const rows = await db
      .select({ name: credentials.name, updatedAt: credentials.updatedAt, byId: users.id, byName: users.name })
      .from(credentials)
      .leftJoin(users, eq(users.id, credentials.updatedBy))
      .where(eq(credentials.environmentId, env.id))
      .orderBy(asc(credentials.name));
    const list: CredentialDto[] = rows.map((r) => ({ name: r.name, updatedAt: r.updatedAt.toISOString(), updatedBy: r.byId ? { id: r.byId, name: r.byName ?? '' } : null }));
    return { credentials: list };
  });

  app.put<CredP>('/api/projects/:id/environments/:envId/credentials/:name', async (req) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'credential.write');
    const env = await loadEnv(project.id, req.params.envId);
    const name = parse(credentialNameSchema, req.params.name);
    const { value } = parse(credentialPutSchema, req.body);
    const ciphertext = encryptSecret(ctx.config.credentialsKey, credentialAad(env.id, name), value);
    const now = ctx.clock.now();
    await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: credentials.id }).from(credentials).where(and(eq(credentials.environmentId, env.id), eq(credentials.name, name)));
      await tx
        .insert(credentials)
        .values({ environmentId: env.id, name, ciphertext, updatedAt: now, updatedBy: principal.user.id })
        .onConflictDoUpdate({ target: [credentials.environmentId, credentials.name], set: { ciphertext, updatedAt: now, updatedBy: principal.user.id } });
      await record(tx, feed, actorOf(principal), {
        projectId: project.id,
        kind: existing ? 'credential.changed' : 'credential.added',
        summary: `테스트 계정 ${existing ? '변경' : '추가'}: ${env.name} / ${name}`,
        targetType: 'environment',
        targetId: env.id,
        details: { environment: env.name, name },
      });
    });
    const out: CredentialDto = { name, updatedAt: now.toISOString(), updatedBy: { id: principal.user.id, name: principal.user.name } };
    return out;
  });

  app.delete<CredP>('/api/projects/:id/environments/:envId/credentials/:name', async (req, reply) => {
    const { project, principal } = await projectAccess(ctx, req, req.params.id, 'credential.write');
    const env = await loadEnv(project.id, req.params.envId);
    const name = parse(credentialNameSchema, req.params.name);
    await db.transaction(async (tx) => {
      const res = await tx.delete(credentials).where(and(eq(credentials.environmentId, env.id), eq(credentials.name, name)));
      if (!res.rowCount) throw notFound('credential');
      await record(tx, feed, actorOf(principal), {
        projectId: project.id,
        kind: 'credential.deleted',
        summary: `테스트 계정 삭제: ${env.name} / ${name}`,
        targetType: 'environment',
        targetId: env.id,
        details: { environment: env.name, name },
      });
    });
    return reply.status(204).send();
  });
}
