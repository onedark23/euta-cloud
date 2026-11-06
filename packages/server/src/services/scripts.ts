// Script reads and saves shared by the REST routes and the remote MCP tools (SPEC 스크립트):
// base-version conflicts (409 with the current version), engine validation (422) except origin
// `external`, the 256 KiB limit, version pruning and the activity/feed entry.
import {
  SCRIPT_MAX_BYTES,
  SCRIPT_VERSIONS_KEPT,
  scriptPathError,
  type ScriptDto,
  type ScriptOrigin,
  type ScriptVersionDto,
} from '@euta-cloud/shared';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { Db, Tx } from '../db/index.js';
import { scripts, scriptVersions, users } from '../db/schema.js';
import { AppError, notFound } from '../http.js';
import { actorOf, type Principal, type ProjectRow } from './access.js';
import { record } from './activity.js';
import { checkScript, scriptHash, type ScriptCheck } from './script-check.js';
import { scriptNameOf } from './script-name.js';

export type ScriptRow = typeof scripts.$inferSelect;
export type VersionRow = typeof scriptVersions.$inferSelect;

export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}

export function scriptPathOf(raw: string): string {
  const e = scriptPathError(raw);
  if (e) throw new AppError(422, 'VALIDATION_FAILED', e, [{ path: 'path', message: e }]);
  return raw;
}

export const versionDto = (v: VersionRow, author: { id: string; name: string } | null, withSource = false): ScriptVersionDto => ({
  version: v.version,
  contentHash: v.contentHash,
  origin: v.origin as ScriptOrigin,
  memo: v.memo,
  author,
  createdAt: v.createdAt.toISOString(),
  validation: { ok: v.validationOk, issues: v.validationIssues },
  ...(withSource ? { source: v.source } : {}),
});

export const scriptDto = (s: ScriptRow, v: VersionRow, authorName: string | null): ScriptDto => ({
  id: s.id,
  path: s.path,
  name: scriptNameOf(v.source, v.contentHash),
  version: s.currentVersion,
  contentHash: v.contentHash,
  validationOk: v.validationOk,
  updatedAt: s.updatedAt.toISOString(),
  updatedBy: v.authorId ? { id: v.authorId, name: authorName ?? '' } : null,
  ...(s.deletedAt ? { deletedAt: s.deletedAt.toISOString() } : {}),
});

/** Scripts of a project joined with their current version and its author. */
export const listScriptRows = (db: Db, projectId: string, where: ReturnType<typeof and>) =>
  db
    .select({ s: scripts, v: scriptVersions, authorName: users.name })
    .from(scripts)
    .innerJoin(scriptVersions, and(eq(scriptVersions.scriptId, scripts.id), eq(scriptVersions.version, scripts.currentVersion)))
    .leftJoin(users, eq(users.id, scriptVersions.authorId))
    .where(and(eq(scripts.projectId, projectId), where))
    .orderBy(asc(scripts.path));

export async function liveScript(db: Db, projectId: string, path: string) {
  const [row] = await listScriptRows(db, projectId, and(eq(scripts.path, path), isNull(scripts.deletedAt)));
  if (!row) throw notFound('script');
  return row;
}

async function currentInfo(tx: Tx, s: ScriptRow) {
  const [row] = await tx
    .select({ v: scriptVersions, authorName: users.name })
    .from(scriptVersions)
    .leftJoin(users, eq(users.id, scriptVersions.authorId))
    .where(and(eq(scriptVersions.scriptId, s.id), eq(scriptVersions.version, s.currentVersion)));
  return row;
}

export async function scriptConflict(tx: Tx, s: ScriptRow | null): Promise<AppError> {
  if (!s) return new AppError(409, 'SCRIPT_CONFLICT', 'the script does not exist on the server (deleted or never saved)', { current: null });
  const cur = await currentInfo(tx, s);
  return new AppError(409, 'SCRIPT_CONFLICT', `the script changed on the server (now version ${s.currentVersion})`, {
    current: cur ? versionDto(cur.v, cur.v.authorId ? { id: cur.v.authorId, name: cur.authorName ?? '' } : null, true) : null,
  });
}

/** Insert a new version (and prune beyond the latest 200). Caller holds the script row lock. */
export async function addScriptVersion(
  ctx: AppContext,
  tx: Tx,
  s: ScriptRow,
  p: Principal,
  source: string,
  origin: ScriptOrigin,
  memo: string | undefined,
  check: { ok: boolean; issues: { path: string; message: string }[] },
  revertedFrom?: number,
) {
  const version = s.currentVersion + 1;
  const now = ctx.clock.now();
  const [v] = await tx
    .insert(scriptVersions)
    .values({
      scriptId: s.id,
      version,
      source,
      contentHash: scriptHash(source),
      authorId: p.user.id,
      origin,
      memo: memo || null,
      validationOk: check.ok,
      validationIssues: check.issues,
      revertedFrom: revertedFrom ?? null,
      createdAt: now,
    })
    .returning();
  const [updated] = await tx.update(scripts).set({ currentVersion: version, updatedAt: now }).where(eq(scripts.id, s.id)).returning();
  await tx.delete(scriptVersions).where(and(eq(scriptVersions.scriptId, s.id), lte(scriptVersions.version, version - SCRIPT_VERSIONS_KEPT)));
  return { script: updated!, version: v! };
}

export interface SaveScriptInput {
  source: string;
  baseVersion?: number | null;
  origin: ScriptOrigin;
  memo?: string;
}

export interface SaveScriptResult {
  script: ScriptDto;
  version: ScriptVersionDto;
  created: boolean;
  unchanged: boolean;
}

/** Size + engine validation before saving (throws 422). */
export function checkForSave(source: string, origin: ScriptOrigin): ScriptCheck {
  if (Buffer.byteLength(source, 'utf8') > SCRIPT_MAX_BYTES) {
    throw new AppError(422, 'SCRIPT_TOO_LARGE', `script must be at most ${SCRIPT_MAX_BYTES / 1024} KiB`);
  }
  const check = checkScript(source);
  if (!check.parsed) throw new AppError(422, 'YAML_PARSE_ERROR', 'the script is not valid YAML', { issues: check.issues });
  // External edits (made outside the app) are kept even when invalid, flagged "validation error".
  if (!check.ok && origin !== 'external') throw new AppError(422, 'SCRIPT_INVALID', 'the script did not pass validation', { issues: check.issues });
  return check;
}

/**
 * Save a script (new script without a base version, or a new version on top of `baseVersion`).
 * Permission is the caller's job (`script.edit`). Records `script.created` / `script.saved` with
 * the principal's actor (a personal token → "AI — <owner> (<token>)").
 */
export async function saveScript(ctx: AppContext, principal: Principal, project: ProjectRow, path: string, body: SaveScriptInput): Promise<SaveScriptResult> {
  const { db, feed } = ctx;
  const check = checkForSave(body.source, body.origin);
  try {
    const out = await db.transaction(async (tx) => {
      const [s] = await tx
        .select()
        .from(scripts)
        .where(and(eq(scripts.projectId, project.id), eq(scripts.path, path), isNull(scripts.deletedAt)))
        .for('update');
      const actor = actorOf(principal);
      if (!s) {
        if (body.baseVersion) throw await scriptConflict(tx, null);
        const [created] = await tx.insert(scripts).values({ projectId: project.id, path }).returning();
        const r = await addScriptVersion(ctx, tx, created!, principal, body.source, body.origin, body.memo, check);
        await record(tx, feed, actor, {
          projectId: project.id,
          kind: 'script.created',
          summary: `스크립트 만들기: ${path}`,
          targetType: 'script',
          targetId: created!.id,
          details: { path, version: r.version.version, origin: body.origin, validationOk: check.ok },
        });
        return { created: true, unchanged: false };
      }
      if (body.baseVersion !== s.currentVersion) throw await scriptConflict(tx, s);
      const cur = await currentInfo(tx, s);
      if (cur && cur.v.contentHash === scriptHash(body.source)) return { created: false, unchanged: true };
      const r = await addScriptVersion(ctx, tx, s, principal, body.source, body.origin, body.memo, check);
      await record(tx, feed, actor, {
        projectId: project.id,
        kind: 'script.saved',
        summary: `스크립트 저장: ${path} (v${r.version.version}${body.origin === 'external' ? ', 앱 바깥 변경' : ''}${check.ok ? '' : ', 검증 오류'})`,
        targetType: 'script',
        targetId: s.id,
        details: { path, version: r.version.version, origin: body.origin, validationOk: check.ok },
      });
      return { created: false, unchanged: false };
    });
    const row = await liveScript(db, project.id, path);
    return {
      script: scriptDto(row.s, row.v, row.authorName),
      version: versionDto(row.v, row.v.authorId ? { id: row.v.authorId, name: row.authorName ?? '' } : null),
      ...out,
    };
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(409, 'SCRIPT_CONFLICT', 'the script was created on the server meanwhile', { current: null });
    throw e;
  }
}
