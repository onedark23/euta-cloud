// Test set report of a cloud set (parent) run (SPEC 프로젝트-관리 "테스트 세트 리포트", ADR-032): the previous
// finished run of the same set in the same environment, the comparison buckets, and per failed child the
// failing step (sentence from the child's pinned script text), its error and its screenshot path from the
// child's run.json. Also the children's `manual` steps ("수동 확인 필요", ADR-037). Read-only; everything
// already masked (engine redaction, stored step errors).
import type { Readable } from 'node:stream';
import { parseYaml } from '@euta/core';
import { scriptNameOf } from './script-name.js';
import { describeStep } from '@euta/core/describe';
import { manualMarker, type RunStatus, type SuiteReportDto, type SuiteReportRef } from '@euta-cloud/shared';
import { and, desc, eq, isNull, lt, notInArray } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import { runs } from '../db/schema.js';
import { AppError } from '../http.js';
import { childrenOf, type RunRow } from './runs.js';

const FAILED = new Set(['failed', 'error', 'timeout', 'aborted']);
const NOT_FINISHED = ['queued', 'leased', 'running', 'skipped'];
const MAX_FAILURES = 20;
const MAX_MANUAL = 200;
const MAX_RUN_JSON = 8 * 1024 * 1024;

/**
 * Children of `cur` against `prev`: same script list → by position, otherwise by script (id, else path) +
 * occurrence. Failed now & not failed before = 새로 실패, passed now & failed before = 회복, failed both =
 * 계속 실패, passed both = 그대로 통과; children that did not run now are left out.
 */
export function compareChildren(cur: Pick<RunRow, 'scriptId' | 'scriptPath' | 'status'>[], prev: Pick<RunRow, 'scriptId' | 'scriptPath' | 'status'>[]): NonNullable<SuiteReportDto['comparison']> {
  const key = (r: Pick<RunRow, 'scriptId' | 'scriptPath'>) => r.scriptId ?? `path:${r.scriptPath ?? ''}`;
  const samePlan = cur.length === prev.length && cur.every((c, i) => key(c) === key(prev[i]!));
  const occ = (list: typeof cur) => {
    const n = new Map<string, number>();
    const m = new Map<string, string>();
    for (const r of list) {
      const k = (n.get(key(r)) ?? 0) + 1;
      n.set(key(r), k);
      m.set(`${key(r)}#${k}`, r.status);
    }
    return m;
  };
  const prevBy = occ(prev);
  const seen = new Map<string, number>();
  const out = { newlyFailing: [] as SuiteReportRef[], recovered: [] as SuiteReportRef[], stillFailing: [] as SuiteReportRef[], stillPassing: [] as SuiteReportRef[] };
  cur.forEach((c, i) => {
    const k = (seen.get(key(c)) ?? 0) + 1;
    seen.set(key(c), k);
    const before = samePlan ? prev[i]!.status : prevBy.get(`${key(c)}#${k}`);
    const ref = { order: i + 1, path: c.scriptPath ?? '?' };
    const wasFail = !!before && FAILED.has(before);
    if (FAILED.has(c.status)) (wasFail ? out.stillFailing : out.newlyFailing).push(ref);
    else if (c.status === 'passed' && wasFail) out.recovered.push(ref);
    else if (c.status === 'passed' && before === 'passed') out.stillPassing.push(ref);
  });
  return out;
}

type StepLike = { stepId?: unknown; status?: unknown; error?: unknown; name?: unknown; action?: unknown; screenshot?: unknown; manual?: unknown; children?: unknown };

/** The deepest failed step: DB steps are flat with hierarchical ids ("2", "2.1"); run.json nests `children`. */
export function failingStepId(steps: StepLike[]): string | undefined {
  const failed = steps.filter((s) => typeof s.stepId === 'string' && FAILED.has(String(s.status))).map((s) => s.stepId as string);
  const first = failed[0];
  if (!first) return undefined;
  return failed.filter((id) => id === first || id.startsWith(`${first}.`)).sort((a, b) => b.split('.').length - a.split('.').length)[0];
}

/** Raw step of a script by engine step id (1-based, groups nest; a download trigger is `.1`). */
export function stepById(script: unknown, stepId: string): unknown {
  let list: unknown = (script as { steps?: unknown } | null)?.steps;
  let step: unknown;
  for (const part of stepId.split('.')) {
    const i = Number(part) - 1;
    if (!Array.isArray(list) || !Number.isInteger(i) || i < 0) return undefined;
    step = list[i];
    const o = step && typeof step === 'object' ? (step as Record<string, unknown>) : undefined;
    const g = o?.group as { steps?: unknown } | undefined;
    const d = o?.expectDownload as { trigger?: unknown } | undefined;
    list = g?.steps ?? (d?.trigger ? [d.trigger] : undefined);
  }
  return step;
}

function flatten(steps: unknown, out: Map<string, StepLike> = new Map()): Map<string, StepLike> {
  for (const s of Array.isArray(steps) ? (steps as StepLike[]) : []) {
    if (!s || typeof s.stepId !== 'string') continue;
    out.set(s.stepId, s);
    flatten(s.children, out);
  }
  return out;
}

async function readText(stream: Readable, max: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of stream) {
    n += (c as Buffer).length;
    if (n > max) {
      stream.destroy();
      return undefined;
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function suiteReport(ctx: AppContext, parent: RunRow): Promise<SuiteReportDto> {
  if (parent.kind !== 'suite') throw new AppError(422, 'NOT_A_SUITE_RUN', 'the set report is for test set runs');
  const kids = await childrenOf(ctx.db, parent.id);
  let previous: SuiteReportDto['previous'] = null;
  let comparison: SuiteReportDto['comparison'] = null;
  if (parent.suiteId) {
    const [p] = await ctx.db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.projectId, parent.projectId),
          eq(runs.kind, 'suite'),
          isNull(runs.parentRunId),
          eq(runs.suiteId, parent.suiteId),
          parent.environmentId ? eq(runs.environmentId, parent.environmentId) : eq(runs.environmentName, parent.environmentName),
          notInArray(runs.status, NOT_FINISHED),
          lt(runs.createdAt, parent.createdAt),
        ),
      )
      .orderBy(desc(runs.createdAt))
      .limit(1);
    if (p) {
      previous = { id: p.id, startedAt: p.startedAt?.toISOString() ?? null, queuedAt: p.createdAt.toISOString(), status: p.status as RunStatus };
      comparison = compareChildren(kids, await childrenOf(ctx.db, p.id));
    }
  }
  const names: Record<string, string> = {};
  const parsed = new Map<string, unknown>();
  for (const c of kids) {
    if (!c.scriptSource) continue;
    parsed.set(c.id, parseYaml(c.scriptSource).value);
    const n = scriptNameOf(c.scriptSource, c.contentHash);
    if (n) names[c.id] = n;
  }
  const failures: SuiteReportDto['failures'] = [];
  for (const [i, c] of kids.entries()) {
    if (!FAILED.has(c.status) || failures.length >= MAX_FAILURES) continue;
    const stepId = failingStepId(c.steps as StepLike[]) ?? null;
    const dbStep = stepId ? (c.steps as StepLike[]).find((s) => s.stepId === stepId) : undefined;
    let sentence: string | null = null;
    let title: string | null = null;
    if (stepId && parsed.has(c.id)) {
      const raw = stepById(parsed.get(c.id), stepId);
      if (raw !== undefined) {
        const d = describeStep(raw);
        sentence = d.sentence;
        title = d.title ?? null;
      }
    }
    let screenshot: string | null = null;
    if (stepId && c.resultFiles === 'present') {
      const f = await ctx.results.get(c.projectId, c.id, 'run.json').catch(() => null);
      const text = f ? await readText(f.stream, MAX_RUN_JSON).catch(() => undefined) : undefined;
      if (text) {
        try {
          const shot = flatten((JSON.parse(text) as { steps?: unknown }).steps).get(stepId)?.screenshot;
          if (typeof shot === 'string') screenshot = shot;
        } catch {
          /* unreadable run.json: no screenshot */
        }
      }
    }
    failures.push({
      runId: c.id,
      order: i + 1,
      path: c.scriptPath ?? '?',
      status: c.status as RunStatus,
      stepId,
      title: title ?? (typeof dbStep?.name === 'string' ? dbStep.name : null),
      sentence: sentence ?? (typeof dbStep?.action === 'string' ? dbStep.action : null),
      error: typeof dbStep?.error === 'string' ? dbStep.error : c.error,
      screenshot,
    });
  }
  const manual: SuiteReportDto['manual'] = [];
  for (const [i, c] of kids.entries()) {
    for (const st of c.steps as StepLike[]) {
      const m = manualMarker(st.manual);
      if (!m || typeof st.stepId !== 'string' || manual.length >= MAX_MANUAL) continue;
      const raw = parsed.has(c.id) ? stepById(parsed.get(c.id), st.stepId) : undefined;
      const title = raw !== undefined ? (describeStep(raw).title ?? null) : null;
      manual.push({
        runId: c.id,
        order: i + 1,
        path: c.scriptPath ?? '?',
        stepId: st.stepId,
        title: title ?? (typeof st.name === 'string' ? st.name : null),
        instruction: m.instruction,
        reason: m.reason ?? null,
        reached: typeof st.error !== 'string',
      });
    }
  }
  return { previous, comparison, names, failures, manual };
}
