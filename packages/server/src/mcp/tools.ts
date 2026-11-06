// Remote MCP tools (SPEC_클라우드-MCP "도구"). Names and input shapes follow the engine's MCP tools
// (ADR-008), but the target is a cloud project: every call goes through `projectAccessFor` (token
// permission ∧ project role) and the same services as the REST API, so feed, activity and run
// side effects are identical. No tool result ever carries a credential value (names only).
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { EUTA_VERSION, extractText, flattenSteps, getJsonSchema, parseYaml, type StepResult } from '@euta/core';
import { describeStep, stepText, type StepDescription } from '@euta/core/describe';
import {
  effectiveRole,
  RUN_SOURCES,
  RUN_STATUSES,
  runCreateSchema,
  runListQuerySchema,
  type PrecheckProblem,
  type ProjectAction,
  type ProjectRole,
} from '@euta-cloud/shared';
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import * as z from 'zod';
import type { AppContext } from '../context.js';
import { environments, projectMembers, projects, runs, schedules, scripts, suites } from '../db/schema.js';
import { AppError, notFound, parse } from '../http.js';
import { environmentList } from '../routes/environments.js';
import { projectDto, ROLE_LABEL, visibleTo } from '../routes/projects.js';
import { scheduleDtos } from '../routes/schedules.js';
import { suiteList } from '../routes/suites.js';
import { canFor, projectAccessFor, roleIn, type Principal, type ProjectRow } from '../services/access.js';
import { dailyUsage } from '../services/daily-cap.js';
import { safeRelPath } from '../services/result-store.js';
import { cancelRun, childrenOf, createRun, listRunRows, loadRun, planRun, precheckSource, runDetailDto, runDto, type RunRow } from '../services/runs.js';
import { liveScript, saveScript, scriptPathOf } from '../services/scripts.js';
import { listScriptRows } from '../services/scripts.js';

export const MCP_SERVER_NAME = 'euta-cloud';

export const MCP_INSTRUCTIONS =
  'euta cloud: shared end-user browser test projects (YAML DSL scripts, environments, suites, runs). ' +
  'Start with list_projects → get_project (read its testRules and follow them; environments list credential NAMES only). ' +
  'Always read_script before save_script and pass its version as baseVersion; on a conflict, read again and redo the edit. ' +
  'validate_script checks text without saving (engine validation + cloud precheck). run_script only queues a run and returns its id — poll get_run. ' +
  'Credentials: write ${secrets.NAME} only inside fill/type values; values live on the server and are never shown. Never ask the user for credential values. ' +
  'Call get_schema for the exact DSL.';

const TEXT_EXT = new Set(['txt', 'csv', 'tsv', 'json', 'jsonl', 'log', 'md', 'xml', 'yaml', 'yml', 'html', 'htm', 'har']);
const IMAGE_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const DEFAULT_MAX_CHARS = 64_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_LISTED_FILES = 300;

/** A user-facing tool failure (returned as `isError`, never thrown to the transport). */
class ToolFail extends Error {
  constructor(
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const json = (value: unknown) => ({ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });
const ok = (value: unknown, ...more: CallToolResult['content']): CallToolResult => ({ content: [json(value), ...more] });

const extOf = (p: string) => (p.includes('.') ? p.split('.').pop()!.toLowerCase() : '');

async function readAll(stream: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of stream) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    n += b.length;
    if (n > max) {
      stream.destroy();
      throw new ToolFail(`파일이 너무 큽니다 (${max} 바이트 초과)`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

// ── Korean messages for server error codes ──────────────────────────────────

const PROBLEM_KO: Record<string, string> = {
  ENVIRONMENT_REQUIRED: '환경을 골라야 합니다 (프로젝트에 기본 환경이 없음)',
  SCRIPT_INVALID: '스크립트 검증 오류',
  OS_INPUT_NOT_ALLOWED: '클라우드에서는 OS 입력(input: os)을 쓸 수 없음',
  SECRET_PLACEMENT: '${secrets.*} 는 fill/type 의 값에만 쓸 수 있음 (goto URL · vars · expect 등 불가)',
  CREDENTIALS_MISSING: '환경에 없는 테스트 계정 이름을 씀',
  TARGET_NOT_PUBLIC: '클라우드 러너가 접속할 수 없는 주소(사내·사설 주소)',
};

const problemKo = (p: PrecheckProblem) => ({ ...p, message: `${PROBLEM_KO[p.code] ?? p.code} — ${p.message}` });

function toolError(e: unknown, ctx: AppContext): CallToolResult {
  let message: string;
  let data: Record<string, unknown> | undefined;
  if (e instanceof ToolFail) {
    message = e.message;
    data = e.data;
  } else if (e instanceof AppError) {
    data = { code: e.code };
    const d = e.details as Record<string, unknown> | unknown[] | undefined;
    switch (e.code) {
      case 'FORBIDDEN':
        message = `권한 없음 — ${e.message}`;
        break;
      case 'NOT_FOUND':
        message = `찾을 수 없음 — ${e.message}`;
        break;
      case 'SCRIPT_CONFLICT': {
        const cur = (d as { current?: Record<string, unknown> | null } | undefined)?.current ?? null;
        message = cur
          ? `저장 충돌 — 서버의 스크립트가 바뀌었습니다(현재 v${String(cur.version)}). 저장하지 않았습니다. read_script 로 다시 읽고 고친 뒤 baseVersion=${String(cur.version)} 으로 저장하세요.`
          : '저장 충돌 — 서버에 이 경로의 스크립트가 없거나(삭제됨) 그사이 새로 만들어졌습니다. list_scripts / read_script 로 확인하세요.';
        data.current = cur;
        break;
      }
      case 'SCRIPT_INVALID':
      case 'YAML_PARSE_ERROR':
        message = `검증 실패 — 저장하지 않았습니다. issues 를 고친 뒤 다시 저장하세요.`;
        data.issues = (d as { issues?: unknown } | undefined)?.issues ?? [];
        break;
      case 'SCRIPT_TOO_LARGE':
        message = `스크립트가 너무 큽니다 — ${e.message}`;
        break;
      case 'DAILY_RUN_CAP_REACHED': {
        const c = d as { cap?: number; used?: number; day?: string } | undefined;
        message = `오늘 이 프로젝트의 클라우드 실행 상한에 도달했습니다 — ${c?.used ?? '?'}/${c?.cap ?? '?'} (${c?.day ?? ''}, 서울 기준). 내일 다시 하거나 프로젝트 소유자에게 상한 조정을 요청하세요.`;
        data.cap = c;
        break;
      }
      case 'RUN_FINISHED':
        message = `이미 끝난 실행입니다 — ${e.message}`;
        break;
      case 'VALIDATION_FAILED':
        message = `입력 오류 — ${e.message}`;
        data.issues = d;
        break;
      case 'RATE_LIMITED':
        message = '호출 상한(토큰당 분당 120회)을 넘었습니다. 잠시 뒤 다시 하세요.';
        break;
      default:
        if (e.code in PROBLEM_KO && Array.isArray(d)) {
          message = '실행 전 검사에서 막혔습니다 — 실행하지 않았습니다. problems 를 고친 뒤 다시 요청하세요.';
          data.problems = (d as PrecheckProblem[]).map(problemKo);
        } else {
          message = e.message;
          if (d !== undefined) data.details = d;
        }
    }
  } else {
    ctx.log.error({ err: { message: (e as Error)?.message, stack: (e as Error)?.stack }, component: 'mcp' }, 'mcp tool failed');
    message = '서버 오류 — 잠시 뒤 다시 시도하세요.';
  }
  return { isError: true, content: [json({ error: message, ...(data ?? {}) })] };
}

// ── Builders ─────────────────────────────────────────────────────────────────

/** Korean step sentences of a script (SPEC_스크립트-보기-편집 "단계 문장"), "3.1 …" numbered. */
export function stepSentences(source: string): string[] {
  const parsed = parseYaml(source);
  const steps = (parsed.value as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return [];
  const out: string[] = [];
  const walk = (list: StepDescription[], prefix: string) =>
    list.forEach((d, i) => {
      const id = `${prefix}${i + 1}`;
      out.push(`${id}. ${stepText(d)}`);
      if (d.children) walk(d.children, `${id}.`);
    });
  walk(steps.map((s) => describeStep(s)), '');
  return out;
}

const runBrief = (r: RunRow) => {
  const d = runDto(r);
  return {
    id: d.id,
    kind: d.kind,
    status: d.status,
    flaky: d.flaky,
    target: d.kind === 'suite' ? { suite: d.suite?.name } : { script: d.script?.path, version: d.script?.version },
    environment: d.environment.name,
    source: d.source,
    requestedBy: d.requestedBy.label,
    queuedAt: d.queuedAt,
    startedAt: d.startedAt,
    finishedAt: d.finishedAt,
    durationMs: d.durationMs,
    summary: d.summary,
    error: d.error,
  };
};

export function buildMcpServer(ctx: AppContext, principal: Principal): McpServer {
  const { db } = ctx;
  const server = new McpServer({ name: MCP_SERVER_NAME, version: EUTA_VERSION }, { instructions: MCP_INSTRUCTIONS });

  const access = async (projectId: string, action: ProjectAction) => {
    try {
      return await projectAccessFor(ctx, principal, projectId, action);
    } catch (e) {
      if (e instanceof AppError && e.code === 'FORBIDDEN') {
        if (principal.tokenPermission === 'read') throw new ToolFail('권한 없음 — 읽기 전용 토큰입니다. 쓰기 도구에는 "읽기·쓰기" 토큰이 필요합니다.', { code: 'FORBIDDEN' });
        const role = await roleIn(ctx, projectId, principal.user.id);
        throw new ToolFail(`권한 없음 — 이 프로젝트에서 ${ROLE_LABEL[role]} 역할이라 이 작업을 할 수 없습니다 (실행은 실행자 이상, 저장·편집은 편집자 이상).`, { code: 'FORBIDDEN' });
      }
      throw e;
    }
  };

  /** A run (any level) by id → its project, after checking `action` there. */
  const runAccess = async (runId: string, action: ProjectAction) => {
    const [r] = await db.select({ projectId: runs.projectId }).from(runs).where(eq(runs.id, runId));
    if (!r) throw notFound('run');
    try {
      const a = await access(r.projectId, action);
      return { ...a, run: await loadRun(db, a.project.id, runId) };
    } catch (e) {
      // A trashed project's runs are invisible.
      if (e instanceof AppError && e.status === 404) throw notFound('run');
      throw e;
    }
  };

  const resolveEnvironmentId = async (project: ProjectRow, ref: string | undefined) => {
    if (!ref) return undefined;
    const rows = await db.select({ id: environments.id, name: environments.name }).from(environments).where(eq(environments.projectId, project.id));
    const hit = rows.find((e) => e.id === ref) ?? rows.find((e) => e.name === ref) ?? rows.find((e) => e.name.toLowerCase() === ref.toLowerCase());
    if (!hit) throw new ToolFail(`환경을 찾을 수 없음: ${ref}`, { environments: rows.map((e) => e.name) });
    return hit.id;
  };

  const resultFilesGuard = (run: RunRow) => {
    if (run.resultFiles === 'expired') throw new ToolFail('파일 만료 — 보관 기간이 지나 이 실행의 결과 파일이 지워졌습니다 (요약·단계 결과는 get_run 으로 볼 수 있음).', { code: 'FILES_EXPIRED' });
    if (run.resultFiles !== 'present') throw new ToolFail('결과 파일이 아직 없습니다 (대기·실행 중이거나 올라오지 않음). get_run 으로 상태를 확인하세요.', { code: 'NO_FILES' });
  };

  const tool = <S extends z.ZodRawShape>(
    name: string,
    def: { title: string; description: string; input: S; readOnly?: boolean },
    run: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
  ) => {
    server.registerTool(
      name,
      { title: def.title, description: def.description, inputSchema: z.object(def.input), annotations: { readOnlyHint: !!def.readOnly } },
      // The SDK validates args against inputSchema before calling.
      (async (args: z.infer<z.ZodObject<S>>) => {
        try {
          return await run(args);
        } catch (e) {
          return toolError(e, ctx);
        }
      }) as never,
    );
  };

  const projectId = z.string().min(1).max(100).describe('Project id (from list_projects).');
  const runId = z.string().min(1).max(100).describe('Run id (from run_script / list_runs / get_run).');
  const scalar = z.union([z.string(), z.number(), z.boolean()]);
  const vars = z.record(z.string(), scalar).optional().describe('Values for ${vars.*} (override script vars). Recorded as-is — never put credentials here.');
  const envRef = z.string().max(200).optional().describe('Environment name or id (default: suite default → project default).');

  // ── Projects ─────────────────────────────────────────────────────────────

  tool(
    'list_projects',
    { title: 'List projects', description: 'Projects you can see, with your role (owner/editor/runner/viewer) and what this token may do (effectiveRole: a read-only token acts as viewer).', input: {}, readOnly: true },
    async () => {
      const mine = await db.select({ projectId: projectMembers.projectId, role: projectMembers.role }).from(projectMembers).where(eq(projectMembers.userId, principal.user.id));
      const roles = new Map(mine.map((m) => [m.projectId, m.role as ProjectRole]));
      const rows = await db.select().from(projects).where(and(isNull(projects.deletedAt), visibleTo([...roles.keys()]))).orderBy(asc(projects.name));
      return ok(
        rows.map((p) => {
          const role = roles.get(p.id) ?? 'viewer';
          return { id: p.id, name: p.name, description: p.description, myRole: role, effectiveRole: effectiveRole(role, principal.tokenPermission) };
        }),
      );
    },
  );

  tool(
    'get_project',
    {
      title: 'Get a project',
      description:
        'Project settings, test rules (follow them when writing scripts), environments (name, base URL, vars, allowed domains, credential NAMES only — values are never shown), suites, daily run usage and the actions this token may perform.',
      input: { projectId },
      readOnly: true,
    },
    async (a) => {
      const { project, role, isMember, creatorName } = await access(a.projectId, 'project.view');
      // The Teams webhook URL is a secret — never part of a tool result, whatever the role.
      const { teamsWebhookUrl: _hidden, ...dto } = projectDto(project, role, principal.tokenPermission, {}, { isMember, creatorName });
      void _hidden;
      const usage = await dailyUsage(db, project.id, ctx.clock.now());
      const envs = await environmentList(ctx, project);
      return ok({
        ...dto,
        can: canFor(role, isMember, principal.tokenPermission),
        dailyRunUsage: { ...usage, cap: project.dailyRunCap },
        environments: envs.map((e) => ({
          id: e.id,
          name: e.name,
          baseUrl: e.baseUrl,
          vars: e.vars,
          allowedDomains: e.allowedDomains,
          isDefault: e.isDefault,
          cloudRunnable: e.cloudRunnable,
          credentialNames: e.credentialNames,
        })),
        suites: await suiteList(ctx, project.id),
      });
    },
  );

  // ── Scripts ──────────────────────────────────────────────────────────────

  tool(
    'list_scripts',
    { title: 'List scripts', description: 'Scripts of a project: path, current version, validation state, last change and the latest run status.', input: { projectId }, readOnly: true },
    async (a) => {
      const { project } = await access(a.projectId, 'project.view');
      const rows = await listScriptRows(db, project.id, isNull(scripts.deletedAt));
      const ids = rows.map((r) => r.s.id);
      const last = ids.length
        ? await db
            .selectDistinctOn([runs.scriptId], { scriptId: runs.scriptId, id: runs.id, status: runs.status, finishedAt: runs.finishedAt, createdAt: runs.createdAt })
            .from(runs)
            .where(and(eq(runs.projectId, project.id), inArray(runs.scriptId, ids)))
            .orderBy(runs.scriptId, desc(runs.createdAt))
        : [];
      const lastOf = new Map(last.map((l) => [l.scriptId, l]));
      return ok(
        rows.map((r) => {
          const l = lastOf.get(r.s.id);
          return {
            path: r.s.path,
            version: r.s.currentVersion,
            validationOk: r.v.validationOk,
            updatedAt: r.s.updatedAt.toISOString(),
            updatedBy: r.authorName,
            lastRun: l ? { id: l.id, status: l.status, at: (l.finishedAt ?? l.createdAt).toISOString() } : null,
          };
        }),
      );
    },
  );

  tool(
    'read_script',
    {
      title: 'Read a script',
      description: 'Source text of a script, its current version (pass it as baseVersion to save_script), validation state and a Korean one-line sentence per step.',
      input: { projectId, path: z.string().max(500).describe('Script path, e.g. "login.yaml" or "checkout/pay.yaml".') },
      readOnly: true,
    },
    async (a) => {
      const { project } = await access(a.projectId, 'project.view');
      const row = await liveScript(db, project.id, scriptPathOf(a.path));
      return ok({
        path: row.s.path,
        version: row.s.currentVersion,
        contentHash: row.v.contentHash,
        origin: row.v.origin,
        updatedAt: row.s.updatedAt.toISOString(),
        updatedBy: row.authorName,
        validation: { ok: row.v.validationOk, issues: row.v.validationIssues },
        steps: stepSentences(row.v.source),
        source: row.v.source,
      });
    },
  );

  tool(
    'get_schema',
    { title: 'Get the script JSON Schema', description: 'JSON Schema (draft-07) of the euta YAML test script DSL.', input: {}, readOnly: true },
    async () => ok(getJsonSchema()),
  );

  tool(
    'validate_script',
    {
      title: 'Validate a script (no save)',
      description:
        'Check script text without saving: engine validation (schema, steps, ${...} references) plus the cloud precheck a run would do against an environment ' +
        '(secrets only in fill/type values, credential names exist in the environment, no input: os, reachable address). Give "source", or "path" to check the saved script.',
      input: {
        projectId,
        source: z.string().max(512 * 1024).optional().describe('YAML script text.'),
        path: z.string().max(500).optional().describe('Saved script path (instead of source).'),
        environment: envRef,
        vars,
      },
      readOnly: true,
    },
    async (a) => {
      if ((a.source === undefined) === (a.path === undefined)) throw new ToolFail('"source" 또는 "path" 중 하나만 주세요.');
      const { project } = await access(a.projectId, 'project.view');
      const source = a.source ?? (await liveScript(db, project.id, scriptPathOf(a.path!))).v.source;
      const environmentId = await resolveEnvironmentId(project, a.environment);
      const r = await precheckSource(ctx, project, source, { ...(environmentId ? { environmentId } : {}), ...(a.vars ? { vars: a.vars } : {}) });
      return ok({
        valid: r.validation.ok,
        issues: r.validation.issues,
        cloudPrecheck: { ...r.precheck, problems: r.precheck.problems.map(problemKo) },
        runnable: r.validation.ok && r.precheck.ok,
      });
    },
  );

  tool(
    'save_script',
    {
      title: 'Save a script',
      description:
        'Save script text as a new version (author = token owner, origin "AI(MCP)"). For an existing script pass baseVersion = the version you read; omit it only for a new path. ' +
        'Validation must pass. On a conflict nothing is saved and the current version is returned — read it again and redo the edit.',
      input: {
        projectId,
        path: z.string().max(500).describe('Script path ending in .yaml/.yml.'),
        source: z.string().max(512 * 1024).describe('Full YAML script text.'),
        baseVersion: z.number().int().positive().optional().describe('Version the edit started from (from read_script). Omit for a new script.'),
        memo: z.string().max(200).optional().describe('Short change note shown in the history.'),
      },
    },
    async (a) => {
      const { project } = await access(a.projectId, 'script.edit');
      const path = scriptPathOf(a.path);
      const out = await saveScript(ctx, principal, project, path, {
        source: a.source,
        baseVersion: a.baseVersion ?? null,
        origin: 'ai_mcp',
        ...(a.memo?.trim() ? { memo: a.memo.trim() } : {}),
      });
      return ok({
        saved: !out.unchanged,
        created: out.created,
        unchanged: out.unchanged,
        path: out.script.path,
        version: out.script.version,
        validation: out.version.validation,
        ...(out.unchanged ? { note: '내용이 현재 버전과 같아 새 버전을 만들지 않았습니다.' } : {}),
      });
    },
  );

  // ── Runs ─────────────────────────────────────────────────────────────────

  tool(
    'run_script',
    {
      title: 'Run a script or suite in the cloud',
      description:
        'Queue a cloud run of a saved script (scriptPath) or a suite (suite name or id) on an environment. Returns the run id immediately — runs can take long; poll get_run. ' +
        'Rejected with the precheck problems or the daily run cap when it cannot run.',
      input: {
        projectId,
        scriptPath: z.string().max(500).optional().describe('Saved script path.'),
        suite: z.string().max(200).optional().describe('Suite name or id (instead of scriptPath).'),
        environment: envRef,
        vars,
      },
    },
    async (a) => {
      if ((a.scriptPath === undefined) === (a.suite === undefined)) throw new ToolFail('"scriptPath" 또는 "suite" 중 하나만 주세요.');
      const { project, principal: p } = await access(a.projectId, 'run.execute');
      let suiteId: string | undefined;
      if (a.suite) {
        const rows = await db.select({ id: suites.id, name: suites.name }).from(suites).where(and(eq(suites.projectId, project.id), or(eq(suites.id, a.suite), eq(suites.name, a.suite))));
        if (!rows[0]) throw new ToolFail(`테스트 세트(suite)를 찾을 수 없음: ${a.suite}`);
        suiteId = rows[0].id;
      }
      const environmentId = await resolveEnvironmentId(project, a.environment);
      const body = parse(runCreateSchema, {
        ...(suiteId ? { suiteId } : { scriptPath: a.scriptPath }),
        ...(environmentId ? { environmentId } : {}),
        ...(a.vars ? { vars: a.vars } : {}),
      });
      const plan = await planRun(ctx, project, body);
      if (plan.problems.length) {
        throw new ToolFail('실행 전 검사에서 막혔습니다 — 실행하지 않았습니다. problems 를 고친 뒤 다시 요청하세요.', { code: plan.problems[0]!.code, problems: plan.problems.map(problemKo) });
      }
      const id = await createRun(ctx, p, project, body, plan);
      const run = await loadRun(db, project.id, id);
      return ok({
        runId: run.id,
        status: run.status,
        target: plan.suite ? { suite: plan.suite.name, scripts: plan.scripts.map((s) => `${s.path} v${s.version}`) } : { script: plan.scripts[0]!.path, version: plan.scripts[0]!.version },
        environment: plan.env!.name,
        next: 'get_run 으로 상태를 확인하세요 (queued → running → passed/failed/error/timeout/cancelled).',
      });
    },
  );

  tool(
    'get_run',
    {
      title: 'Get run details',
      description:
        'Status, current step, duration, per-step results, failures, failed expects, metrics, error, suite children and the result file list (for get_screenshot / get_artifact).',
      input: { runId },
      readOnly: true,
    },
    async (a) => {
      const { project, run } = await runAccess(a.runId, 'project.view');
      const d = runDetailDto(run, run.kind === 'suite' ? await childrenOf(db, run.id) : undefined);
      const files = run.resultFiles === 'present' ? await ctx.results.list(project.id, run.id) : [];
      return ok({
        ...runBrief(run),
        projectId: project.id,
        parentRunId: d.parentRunId,
        currentStep: d.currentStep,
        stopRequested: d.stopRequested,
        runnerLocation: d.runnerLocation,
        vars: d.vars,
        credentialNames: d.credentialNames,
        steps: d.steps,
        failures: d.steps.filter((s) => s.status === 'failed' || s.status === 'error'),
        failedExpects: d.expects.filter((x) => !x.passed),
        metrics: d.metrics,
        ...(d.children ? { children: d.children.map((c) => ({ id: c.id, status: c.status, script: c.script?.path, durationMs: c.durationMs, summary: c.summary, error: c.error })) } : {}),
        resultFiles: run.resultFiles,
        ...(run.resultFiles === 'expired' ? { note: '파일 만료 — 결과 파일은 보관 기간이 지나 지워졌습니다.' } : {}),
        files: files.slice(0, MAX_LISTED_FILES).map((f) => f.path),
        ...(files.length > MAX_LISTED_FILES ? { filesTruncated: files.length } : {}),
      });
    },
  );

  tool(
    'list_runs',
    {
      title: 'List runs',
      description: 'Runs of a project, newest first. Filters: target (script path / script id / suite id), environment (name or id), status, source.',
      input: {
        projectId,
        target: z.string().max(500).optional(),
        environment: z.string().max(200).optional(),
        status: z.enum(RUN_STATUSES).optional(),
        source: z.enum(RUN_SOURCES).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Max rows (default 20).'),
      },
      readOnly: true,
    },
    async (a) => {
      const { project } = await access(a.projectId, 'project.view');
      const q = parse(runListQuerySchema, {
        limit: a.limit ?? 20,
        ...(a.target ? { target: a.target } : {}),
        ...(a.environment ? { env: a.environment } : {}),
        ...(a.status ? { status: a.status } : {}),
        ...(a.source ? { source: a.source } : {}),
      });
      return ok((await listRunRows(ctx, project.id, q)).map(runBrief));
    },
  );

  tool(
    'get_screenshot',
    {
      title: 'Get a screenshot',
      description: 'A screenshot image from a run: by stepId (the step screenshot) or by file (e.g. "screenshots/3.png", "diffs/x.png"). "파일 만료" when the result files were removed.',
      input: {
        runId,
        stepId: z.string().max(50).optional().describe('Hierarchical step id, e.g. "3" or "10.1".'),
        file: z.string().max(1000).optional().describe('Image path relative to the run folder.'),
      },
      readOnly: true,
    },
    async (a) => {
      if ((a.stepId === undefined) === (a.file === undefined)) throw new ToolFail('"stepId" 또는 "file" 중 하나만 주세요.');
      const { project, run } = await runAccess(a.runId, 'project.view');
      resultFilesGuard(run);
      let rel = a.file !== undefined ? safeRelPath(a.file) : null;
      if (a.stepId !== undefined) {
        const f = await ctx.results.get(project.id, run.id, 'run.json');
        if (!f) throw new ToolFail('run.json 이 없어 단계 스크린샷을 찾을 수 없습니다. get_run 의 files 에서 file 로 지정하세요.');
        const record = JSON.parse((await readAll(f.stream, MAX_READ_BYTES)).toString('utf8')) as { steps?: StepResult[] };
        const step = flattenSteps(record.steps ?? []).find((s) => s.stepId === a.stepId);
        if (!step) throw new ToolFail(`단계 ${a.stepId} 가 이 실행에 없습니다.`);
        if (!step.screenshot) throw new ToolFail(`단계 ${a.stepId} 에는 스크린샷이 없습니다 (기록 설정이 실패 시만일 수 있음). get_run 의 files 를 보세요.`);
        rel = safeRelPath(step.screenshot);
      }
      if (!rel) throw new ToolFail('잘못된 파일 경로입니다.');
      const mime = IMAGE_EXT[extOf(rel)];
      if (!mime) throw new ToolFail(`이미지가 아닙니다: ${rel} (텍스트는 get_artifact)`);
      const f = await ctx.results.get(project.id, run.id, rel);
      if (!f) throw new ToolFail(`파일이 없습니다: ${rel}`);
      const buf = await readAll(f.stream, MAX_IMAGE_BYTES);
      return ok({ file: rel, size: buf.length }, { type: 'image', data: buf.toString('base64'), mimeType: mime });
    },
  );

  tool(
    'get_artifact',
    {
      title: 'Read a run artifact',
      description:
        'Read a text file from a run folder: run.log, steps.jsonl, console.jsonl, metrics.json, run.json, downloaded files (artifacts/*.csv …, text extracted from PDFs). Size-capped; binary files return metadata only. "파일 만료" when the result files were removed.',
      input: {
        runId,
        file: z.string().max(1000).describe('Path relative to the run folder, e.g. "run.log" or "artifacts/report.csv".'),
        maxChars: z.number().int().min(1).max(1_000_000).optional().describe(`Max characters returned (default ${DEFAULT_MAX_CHARS}).`),
      },
      readOnly: true,
    },
    async (a) => {
      const { project, run } = await runAccess(a.runId, 'project.view');
      resultFilesGuard(run);
      const rel = safeRelPath(a.file);
      if (!rel) throw new ToolFail('잘못된 파일 경로입니다.');
      const ext = extOf(rel);
      const f = await ctx.results.get(project.id, run.id, rel);
      if (!f) throw new ToolFail(`파일이 없습니다: ${rel}`);
      if (IMAGE_EXT[ext]) {
        f.stream.destroy();
        return ok({ file: rel, size: f.size, note: '이미지 — get_screenshot 의 file 로 보세요.' });
      }
      const max = a.maxChars ?? DEFAULT_MAX_CHARS;
      let body: string;
      let kind: string;
      if (ext === 'pdf') {
        const buf = await readAll(f.stream, 32 * 1024 * 1024);
        const dir = await mkdtemp(join(tmpdir(), 'euta-mcp-pdf-'));
        try {
          await writeFile(join(dir, 'file.pdf'), buf);
          body = await extractText(join(dir, 'file.pdf'));
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
        kind = 'pdf-text';
      } else {
        if (f.size > MAX_READ_BYTES && !TEXT_EXT.has(ext)) {
          f.stream.destroy();
          return ok({ file: rel, size: f.size, note: '바이너리 파일 — 내용은 돌려주지 않습니다.' });
        }
        const buf = await readAll(f.stream, Math.max(MAX_READ_BYTES, Math.min(f.size, 16 * 1024 * 1024)));
        if (!TEXT_EXT.has(ext) && buf.subarray(0, 8000).includes(0)) return ok({ file: rel, size: f.size, note: '바이너리 파일 — 내용은 돌려주지 않습니다.' });
        body = buf.toString('utf8');
        kind = 'text';
      }
      const truncated = body.length > max;
      return ok({ file: rel, size: f.size, kind, truncated, ...(truncated ? { returnedChars: max, totalChars: body.length } : {}) }, json(truncated ? body.slice(0, max) : body));
    },
  );

  tool(
    'cancel_run',
    { title: 'Cancel a run', description: 'Cancel a queued or running run (a suite cancels its remaining scripts, except items marked always-run, which still run). A running run stops after the runner kills the engine.', input: { runId } },
    async (a) => {
      const { project, principal: p, run } = await runAccess(a.runId, 'run.execute');
      const out = await cancelRun(ctx, p, project.id, run.id);
      return ok({ runId: out.id, status: out.status, stopRequested: out.stopRequested, ...(out.status === 'cancelled' ? {} : { note: '러너가 실행을 멈추는 중입니다. get_run 으로 확인하세요.' }) });
    },
  );

  // ── Schedules (read only) ───────────────────────────────────────────────

  tool(
    'list_schedules',
    { title: 'List schedules', description: 'Schedules of a project: target, environment, cadence, enabled, next run time and the latest result. (Creating/changing schedules is web/app only.)', input: { projectId }, readOnly: true },
    async (a) => {
      const { project } = await access(a.projectId, 'project.view');
      const rows = await db.select().from(schedules).where(eq(schedules.projectId, project.id)).orderBy(asc(schedules.name), asc(schedules.createdAt));
      return ok(await scheduleDtos(ctx, rows));
    },
  );

  return server;
}

/** Tool names in SPEC order (the smoke test compares the advertised list with this). */
export const MCP_TOOL_NAMES = [
  'list_projects',
  'get_project',
  'list_scripts',
  'read_script',
  'get_schema',
  'validate_script',
  'save_script',
  'run_script',
  'get_run',
  'list_runs',
  'get_screenshot',
  'get_artifact',
  'cancel_run',
  'list_schedules',
] as const;
