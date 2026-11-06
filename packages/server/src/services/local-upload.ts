// Local run upload (SPEC_클라우드-앱-연동 "로컬 실행 올리기"): the app sends one engine run folder as a
// tar (entries relative to the run folder: run.json, steps.jsonl, screenshots/…). Stored with the same
// ResultStore + tar checks as runner uploads (ADR-021); a finished run row is created from run.json
// with source `local_upload`, runner location "PC — <name>", linked to the cloud script version
// whose content hash equals run.json `scriptHash` — otherwise marked "local modified".
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { RunStatus } from '@euta-cloud/shared';
import { manualMarker, runUploadQuerySchema } from '@euta-cloud/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type * as z from 'zod';
import type { AppContext } from '../context.js';
import { environments, runs, scripts, scriptVersions } from '../db/schema.js';
import { AppError } from '../http.js';
import { actorOf, type Principal, type ProjectRow } from './access.js';
import { record } from './activity.js';
import { extractTar, TarRejected } from './tar-upload.js';

const JSON_MAX = 8 * 1024 * 1024;
const ENGINE_STATUSES = ['passed', 'failed', 'error'] as const;

type UploadQuery = z.output<typeof runUploadQuerySchema>;

interface EngineStep {
  stepId?: unknown;
  index?: unknown;
  action?: unknown;
  name?: unknown;
  status?: unknown;
  durationMs?: unknown;
  error?: unknown;
  reloads?: unknown;
  manual?: unknown;
  expects?: { condition?: unknown; passed?: unknown; expected?: unknown; actual?: unknown }[];
  children?: EngineStep[];
}

interface EngineRunJson {
  id?: unknown;
  status?: unknown;
  scriptHash?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  durationMs?: unknown;
  summary?: { total?: unknown; passed?: unknown; failed?: unknown; error?: unknown; skipped?: unknown };
  steps?: EngineStep[];
  record?: { video?: unknown; trace?: unknown };
  error?: unknown;
}

async function bufferOf(data: Readable, max: number, name: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of data) {
    n += (c as Buffer).length;
    if (n > max) throw new TarRejected(`${name} is larger than ${max} bytes`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0);
const date = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const clip = (v: unknown, max = 500): unknown => {
  if (v === undefined) return undefined;
  const s = JSON.stringify(v);
  return s && s.length > max ? `${s.slice(0, max)}…` : v;
};
const recordValue = (v: unknown) => (v === true || v === 'on-failure' ? v : false);

/** Flatten nested engine step results into the run row's step index (same shape as runner events). */
function flatten(steps: EngineStep[] | undefined) {
  const out: Record<string, unknown>[] = [];
  const expects: Record<string, unknown>[] = [];
  const walk = (list: EngineStep[]) => {
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      const manual = manualMarker(s.manual);
      out.push({
        stepId: String(s.stepId ?? ''),
        index: num(s.index),
        action: String(s.action ?? ''),
        ...(typeof s.name === 'string' ? { name: s.name } : {}),
        status: String(s.status ?? ''),
        durationMs: num(s.durationMs),
        ...(typeof s.error === 'string' ? { error: s.error.slice(0, 2000) } : {}),
        ...(typeof s.reloads === 'number' ? { reloads: s.reloads } : {}),
        ...(manual ? { manual } : {}),
      });
      for (const e of s.expects ?? []) {
        expects.push({ stepId: String(s.stepId ?? ''), condition: String(e.condition ?? ''), passed: e.passed === true, expected: clip(e.expected), actual: clip(e.actual) });
      }
      if (Array.isArray(s.children)) walk(s.children);
    }
  };
  walk(Array.isArray(steps) ? steps : []);
  return { steps: out.sort((a, b) => (a.index as number) - (b.index as number)), expects };
}

export async function uploadLocalRun(ctx: AppContext, principal: Principal, project: ProjectRow, q: UploadQuery, body: Readable): Promise<string> {
  const runId = randomUUID();
  let runJsonRaw: Buffer | null = null;
  let metricsRaw: Buffer | null = null;
  let res: { files: number; bytes: number };
  try {
    res = await extractTar(body, ctx.config.resultMaxRunBytes, async (rel, data) => {
      if (rel === 'run.json' || rel === 'metrics.json') {
        const buf = await bufferOf(data, JSON_MAX, rel);
        if (rel === 'run.json') runJsonRaw = buf;
        else metricsRaw = buf;
        return ctx.results.put(project.id, runId, rel, Readable.from([buf]));
      }
      return ctx.results.put(project.id, runId, rel, data);
    });
  } catch (e) {
    await ctx.results.deleteRun(project.id, runId);
    throw e;
  }
  try {
    if (!runJsonRaw) throw new AppError(422, 'RUN_JSON_MISSING', 'the upload has no run.json at the top level (tar the engine run folder contents)');
    let rj: EngineRunJson;
    try {
      rj = JSON.parse((runJsonRaw as Buffer).toString('utf8')) as EngineRunJson;
    } catch {
      throw new AppError(422, 'RUN_JSON_INVALID', 'run.json is not valid JSON');
    }
    if (!rj || typeof rj !== 'object' || !(ENGINE_STATUSES as readonly string[]).includes(String(rj.status))) {
      throw new AppError(422, 'RUN_JSON_INVALID', 'run.json has no final status (passed, failed or error) — upload a finished run');
    }
    let metrics: Record<string, unknown>[] = [];
    if (metricsRaw) {
      try {
        const m = JSON.parse((metricsRaw as Buffer).toString('utf8')) as unknown;
        const list = Array.isArray(m) ? m : Array.isArray((m as { metrics?: unknown })?.metrics) ? (m as { metrics: unknown[] }).metrics : [];
        metrics = (list as Record<string, unknown>[])
          .filter((x) => x && typeof x === 'object')
          .slice(0, 5000)
          .map((x) => ({ name: x.name, value: x.value, unit: x.unit, ...(x.stepId ? { stepId: x.stepId } : {}) }));
      } catch {
        /* metrics are optional */
      }
    }

    // Script version link by content hash (newest matching version); otherwise "local modified".
    const hash = typeof rj.scriptHash === 'string' && /^[a-f0-9]{64}$/.test(rj.scriptHash) ? rj.scriptHash : null;
    const [script] = await ctx.db.select({ id: scripts.id }).from(scripts).where(and(eq(scripts.projectId, project.id), eq(scripts.path, q.scriptPath), isNull(scripts.deletedAt)));
    const [version] =
      script && hash
        ? await ctx.db
            .select({ version: scriptVersions.version })
            .from(scriptVersions)
            .where(and(eq(scriptVersions.scriptId, script.id), eq(scriptVersions.contentHash, hash)))
            .orderBy(desc(scriptVersions.version))
            .limit(1)
        : [];

    let env: { id: string; name: string } | null = null;
    if (q.environmentId) {
      const [e] = await ctx.db.select({ id: environments.id, name: environments.name }).from(environments).where(and(eq(environments.id, q.environmentId), eq(environments.projectId, project.id)));
      if (!e) throw new AppError(422, 'VALIDATION_FAILED', 'unknown environment', [{ path: 'environmentId', message: 'unknown environment' }]);
      env = e;
    }
    const { steps, expects } = flatten(rj.steps);
    const startedAt = date(rj.startedAt);
    const finishedAt = date(rj.finishedAt) ?? ctx.clock.now();
    const actor = actorOf(principal);
    const status = rj.status as RunStatus;
    const s = rj.summary ?? {};
    await ctx.db.transaction(async (tx) => {
      await tx.insert(runs).values({
        id: runId,
        projectId: project.id,
        kind: 'script',
        scriptId: script?.id ?? null,
        scriptPath: q.scriptPath,
        scriptVersion: version?.version ?? null,
        contentHash: hash,
        environmentId: env?.id ?? null,
        environmentName: env?.name ?? q.environmentName ?? '(로컬)',
        source: 'local_upload',
        requestedBy: principal.user.id,
        requestedByLabel: actor.label,
        actorType: actor.type,
        timeLimitSec: project.runTimeLimitSec,
        record: { video: recordValue(rj.record?.video), trace: recordValue(rj.record?.trace) },
        status,
        runnerLocation: `PC — ${principal.user.name}`,
        engineRunId: typeof rj.id === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(rj.id) ? rj.id : null,
        summary: { total: num(s.total), passed: num(s.passed), failed: num(s.failed), error: num(s.error), skipped: num(s.skipped) },
        durationMs: typeof rj.durationMs === 'number' ? Math.round(rj.durationMs) : startedAt ? finishedAt.getTime() - startedAt.getTime() : null,
        steps,
        metrics,
        expects,
        error: typeof rj.error === 'string' ? rj.error.slice(0, 2000) : null,
        resultFiles: 'present',
        resultBytes: res.bytes,
        localModified: !version,
        createdAt: ctx.clock.now(),
        startedAt,
        finishedAt,
      });
      await record(tx, ctx.feed, actor, {
        projectId: project.id,
        kind: 'run.uploaded',
        summary: `로컬 실행 올리기: ${q.scriptPath}${version ? ` v${version.version}` : ' (로컬 수정본)'} — ${status}`,
        targetType: 'run',
        targetId: runId,
        details: { status, script: q.scriptPath, environment: env?.name ?? q.environmentName ?? null, localModified: !version, files: res.files },
        feedData: { runId, status, source: 'local_upload' },
      });
    });
    return runId;
  } catch (e) {
    await ctx.results.deleteRun(project.id, runId);
    throw e;
  }
}
