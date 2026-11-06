// SPEC 계정 "스크립트 표시" (ADR-044): the YAML `name:` travels with scripts, runs (the pinned
// version's name) and schedules, so screens can show names with the path small. No name → null.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scriptNameOf } from '../src/services/script-name.js';
import { TestEnv } from './helpers.js';
import { projectFixture, requestRun, saveScript, SIMPLE_SCRIPT, type ProjectFixture } from './run-helpers.js';
import { createSchedule } from './schedule-helpers.js';

const NAMELESS = `version: 1
target:
  baseUrl: \${env.BASE_URL}
steps:
  - goto: /
`;

describe('script names', () => {
  let env: TestEnv;
  let f: ProjectFixture;

  beforeAll(async () => {
    env = await TestEnv.create();
    f = await projectFixture(env);
    await saveScript(env, f, 'checkout/report-export.yaml', SIMPLE_SCRIPT('로그인 후 보고서 내보내기'));
    // `name` is required by the DSL, so a nameless script only arrives as an external edit (stored, flagged).
    await saveScript(env, f, 'nameless.yaml', NAMELESS, 'external');
  });
  afterAll(async () => env?.close());

  it('the script list carries the current name, null when the YAML has none', async () => {
    const list = await env.req('GET', `/api/projects/${f.pid}/scripts`, { cookie: f.viewer.cookie });
    const byPath = Object.fromEntries(list.body.scripts.map((s: { path: string; name: string | null }) => [s.path, s.name]));
    expect(byPath).toMatchObject({ 'checkout/report-export.yaml': '로그인 후 보고서 내보내기', 'nameless.yaml': null });
  });

  it('a run keeps the name of the version it pinned', async () => {
    const run = await requestRun(env, f, { scriptPath: 'checkout/report-export.yaml' });
    expect(run.status).toBe(201);
    expect(run.body.script).toMatchObject({ path: 'checkout/report-export.yaml', name: '로그인 후 보고서 내보내기' });
    await saveScript(env, f, 'checkout/report-export.yaml', SIMPLE_SCRIPT('보고서 내보내기 (새 이름)'));
    const again = await env.req('GET', `/api/projects/${f.pid}/runs/${run.body.id}`, { cookie: f.viewer.cookie });
    expect(again.body.script.name).toBe('로그인 후 보고서 내보내기');
    const list = await env.req('GET', `/api/projects/${f.pid}/runs`, { cookie: f.viewer.cookie });
    expect(list.body.runs.find((r: { id: string }) => r.id === run.body.id).script.name).toBe('로그인 후 보고서 내보내기');
  });

  it('a schedule shows the current name of its script', async () => {
    const list = await env.req('GET', `/api/projects/${f.pid}/scripts`, { cookie: f.viewer.cookie });
    const scriptId = list.body.scripts.find((s: { path: string }) => s.path === 'checkout/report-export.yaml').id;
    const s = await createSchedule(env, f, { name: '매일', scriptId, cadence: { kind: 'daily', time: '09:00' }, enabled: false });
    expect(s.status).toBe(201);
    expect(s.body.target).toEqual({ kind: 'script', script: { id: scriptId, path: 'checkout/report-export.yaml', name: '보고서 내보내기 (새 이름)' } });
  });

  it('scriptNameOf: trims, ignores non-strings and unparsable text', () => {
    expect(scriptNameOf('name: "  공백  "\nsteps: []\n')).toBe('공백');
    expect(scriptNameOf('name: 3\n')).toBeNull();
    expect(scriptNameOf('name: [unclosed\n')).toBeNull();
    expect(scriptNameOf('')).toBeNull();
  });
});
