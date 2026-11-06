// Local run upload (SPEC_클라우드-앱-연동 "로컬 실행 올리기"): editor+ only, tar safety (same checks as
// runner uploads), run.json → finished run row, script version link by content hash vs "local
// modified", runner location "PC — <name>", files downloadable, not counted against the daily cap.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scriptHash } from '@euta/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestEnv } from './helpers.js';
import { makeTar, projectFixture, saveScript, SIMPLE_SCRIPT, type ProjectFixture, type TarEntry } from './run-helpers.js';

const SOURCE_V1 = SIMPLE_SCRIPT('Up');
const SOURCE_V2 = SIMPLE_SCRIPT('Up', '  - goto: /two\n');

function runJson(source: string, over: Record<string, unknown> = {}) {
  return JSON.stringify({
    id: '20261113-101500_up_abc123',
    kind: 'script',
    name: 'Up',
    scriptPath: '/Users/me/project/scripts/up.yaml',
    scriptHash: scriptHash(source),
    startedAt: '2026-11-13T01:15:00.000Z',
    finishedAt: '2026-11-13T01:15:03.500Z',
    durationMs: 3500,
    status: 'failed',
    summary: { total: 2, passed: 1, failed: 1, error: 0, skipped: 0 },
    record: { video: true, trace: false },
    steps: [
      { stepId: '1', index: 0, action: 'goto', status: 'passed', durationMs: 100, expects: [] },
      {
        stepId: '2',
        index: 1,
        action: 'group',
        status: 'failed',
        durationMs: 200,
        expects: [],
        children: [{ stepId: '2.1', index: 2, action: 'expect', status: 'failed', durationMs: 50, error: 'expected heading', expects: [{ condition: 'visible', passed: false, expected: true, actual: false }] }],
      },
    ],
    ...over,
  });
}

describe('local run upload', () => {
  let env: TestEnv;
  let f: ProjectFixture;

  beforeAll(async () => {
    env = await TestEnv.create();
    f = await projectFixture(env);
    await saveScript(env, f, 'up.yaml', SOURCE_V1);
  });
  afterAll(async () => env?.close());

  const upload = async (entries: TarEntry[], query = 'scriptPath=up.yaml', cookie = f.editor.cookie) =>
    env.req('POST', `/api/projects/${f.pid}/runs/upload?${query}`, { cookie, body: await makeTar(entries), headers: { 'content-type': 'application/x-tar' } });

  const files = (body: string) => [
    { name: 'run.json', body },
    { name: 'steps.jsonl', body: '{"type":"run.started"}\n' },
    { name: 'report.html', body: '<html></html>' },
    { name: 'screenshots/2.1.png', body: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { name: 'metrics.json', body: JSON.stringify([{ name: 'lcp', value: 1200, unit: 'ms', ts: 'x' }]) },
  ];

  it('creates a finished local_upload run linked to the matching cloud version', async () => {
    const r = await upload(files(runJson(SOURCE_V1)), `scriptPath=up.yaml&environmentId=${f.envId}`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: 'failed',
      source: 'local_upload',
      runnerLocation: 'PC — editor',
      requestedBy: { id: f.editor.id, label: 'editor' },
      environment: { id: f.envId, name: 'dev' },
      script: { path: 'up.yaml', version: 1, contentHash: scriptHash(SOURCE_V1) },
      localModified: false,
      resultFiles: 'present',
      durationMs: 3500,
      summary: { total: 2, passed: 1, failed: 1 },
      record: { video: true, trace: false },
    });
    expect(r.body.steps.map((s: { stepId: string }) => s.stepId)).toEqual(['1', '2', '2.1']);
    expect(r.body.expects).toEqual([{ stepId: '2.1', condition: 'visible', passed: false, expected: true, actual: false }]);
    expect(r.body.metrics).toEqual([{ name: 'lcp', value: 1200, unit: 'ms' }]);
    const list = await env.req('GET', `/api/projects/${f.pid}/runs/${r.body.id}/files`, { cookie: f.viewer.cookie });
    expect(list.body.files.map((x: { path: string }) => x.path).sort()).toEqual(['metrics.json', 'report.html', 'run.json', 'screenshots/2.1.png', 'steps.jsonl']);
    const listed = await env.req('GET', `/api/projects/${f.pid}/runs?source=local_upload`, { cookie: f.viewer.cookie });
    expect(listed.body.runs.map((x: { id: string }) => x.id)).toContain(r.body.id);
    const act = await env.req('GET', `/api/projects/${f.pid}/activity?kind=run.uploaded`, { cookie: f.viewer.cookie });
    expect(act.body.entries[0].summary).toMatch(/로컬 실행 올리기: up\.yaml v1/);
  });

  it('keeps the engine `manual` marker of run.json steps (nested too)', async () => {
    const steps = [
      { stepId: '1', index: 0, action: 'manual', status: 'skipped', durationMs: 0, manual: { instruction: '로고 확인', reason: '사람 판단' }, expects: [] },
      {
        stepId: '2',
        index: 1,
        action: 'group',
        status: 'failed',
        durationMs: 9,
        expects: [],
        children: [
          { stepId: '2.1', index: 2, action: 'click', status: 'failed', durationMs: 9, error: 'not found', expects: [] },
          { stepId: '2.2', index: 3, action: 'manual', status: 'skipped', durationMs: 0, error: 'skipped after step 2.1 failed', manual: { instruction: '메일 확인' }, expects: [] },
        ],
      },
    ];
    const r = await upload(files(runJson(SOURCE_V1, { steps })));
    expect(r.status).toBe(201);
    expect(r.body.steps.map((s: { stepId: string; manual?: unknown }) => [s.stepId, s.manual ?? null])).toEqual([
      ['1', { instruction: '로고 확인', reason: '사람 판단' }],
      ['2', null],
      ['2.1', null],
      ['2.2', { instruction: '메일 확인' }],
    ]);
  });

  it('marks a run whose script text matches no cloud version as local modified', async () => {
    const r = await upload(files(runJson(SOURCE_V2, { status: 'passed' })), 'scriptPath=up.yaml&environmentName=local-dev');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'passed', localModified: true, environment: { id: null, name: 'local-dev' }, script: { version: 0 } });
    // Saving that text later does not rewrite history.
    await saveScript(env, f, 'up.yaml', SOURCE_V2);
    const again = await upload(files(runJson(SOURCE_V2, { status: 'passed' })));
    expect(again.body).toMatchObject({ localModified: false, script: { version: 2 } });
  });

  it('rejects path traversal / links (nothing stored) and uploads without run.json', async () => {
    const before = readdirSync(join(env.ctx.config.resultsDir, f.pid)).length;
    for (const bad of [
      [{ name: 'run.json', body: runJson(SOURCE_V1) }, { name: '../../escape.txt', body: 'x' }],
      [{ name: 'run.json', body: runJson(SOURCE_V1) }, { name: '/etc/evil', body: 'x' }],
      [{ name: 'run.json', body: runJson(SOURCE_V1) }, { name: 'link', type: 'symlink' as const, linkname: '/etc/passwd' }],
    ]) {
      const r = await upload(bad);
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('TAR_REJECTED');
    }
    expect((await upload([{ name: 'steps.jsonl', body: '' }])).body.error.code).toBe('RUN_JSON_MISSING');
    expect((await upload([{ name: 'run.json', body: '{"status":"running"}' }])).body.error.code).toBe('RUN_JSON_INVALID');
    expect(readdirSync(join(env.ctx.config.resultsDir, f.pid)).length).toBe(before);
    expect(existsSync(join(env.ctx.config.resultsDir, 'escape.txt'))).toBe(false);
  });

  it('is editor+ only, and needs a tar body', async () => {
    const viewer = await upload(files(runJson(SOURCE_V1)), 'scriptPath=up.yaml', f.viewer.cookie);
    expect(viewer.status).toBe(403);
    const json = await env.req('POST', `/api/projects/${f.pid}/runs/upload?scriptPath=up.yaml`, { cookie: f.editor.cookie, body: { a: 1 } });
    expect(json.status).toBe(415);
    const noPath = await upload(files(runJson(SOURCE_V1)), '');
    expect(noPath.status).toBe(422);
  });

  it('does not count against the daily run cap', async () => {
    const p = await env.req('GET', `/api/projects/${f.pid}`, { cookie: f.viewer.cookie });
    expect(p.body.dailyRunUsage).toMatchObject({ used: 0, cap: 50 });
  });
});
