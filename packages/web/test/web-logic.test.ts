// Web logic without a browser: route matching, script URL paths, conflict copy names, run-file parsing,
// step lookup by engine step id, key=value vars, cadence text, the copied editor model / step diff.
import { describe, expect, it } from 'vitest';
import { cadenceText, parseKeyValues } from '../src/format';
import { stepById } from '../src/project/run-detail';
import { flattenRunJsonSteps, parseEventLog } from '../src/project/run-files';
import { problemText } from '../src/project/run-panel';
import { copyPathFor, templateFor } from '../src/project/script-detail';
import { encodePath, matchPath, safeNext } from '../src/router';
import { diffScripts } from '../src/script/diff';
import { friendly, koSecretRule } from '../src/script/messages';
import { addStep, flatten, fromModel, groupIn, groupOut, issueStepPath, moveDown, setStep, toModel, toPayload } from '../src/script/model';

describe('router', () => {
  it('matches params and a trailing wildcard (script paths keep their slashes)', () => {
    expect(matchPath('/projects/:id', '/projects/p1')).toEqual({ id: 'p1' });
    expect(matchPath('/projects/:id/runs/:runId', '/projects/p1/runs/r%2F1')).toEqual({ id: 'p1', runId: 'r/1' });
    expect(matchPath('/projects/:id/scripts/*', '/projects/p1/scripts/checkout/%EA%B2%B0%EC%A0%9C.yaml')).toEqual({ id: 'p1', '*': 'checkout/결제.yaml' });
    expect(matchPath('/projects/:id/scripts/*', '/projects/p1/scripts')).toBeNull();
    expect(matchPath('/projects/:id', '/projects/p1/runs')).toBeNull();
    expect(matchPath('/projects/:id/runs', '/projects/p1/schedules')).toBeNull();
  });
  it('encodes each path segment and keeps "/"; next= stays on the site', () => {
    expect(encodePath('a b/c#d.yaml')).toBe('a%20b/c%23d.yaml');
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/projects/x')).toBe('/projects/x');
  });
});

describe('script detail helpers', () => {
  it('conflict copy path: <name>-<my name>.yaml, then -2, -3', () => {
    expect(copyPathFor('checkout/pay.yaml', '박 동료', new Set())).toBe('checkout/pay-박-동료.yaml');
    expect(copyPathFor('login.yml', 'a/b', new Set(['login-a-b.yml']))).toBe('login-a-b-2.yml');
    expect(copyPathFor('login.yaml', '...', new Set())).toBe('login-copy.yaml');
  });
  it('new script template names the script after the file', () => {
    expect(templateFor('checkout/pay.yaml')).toContain('name: "pay"');
    expect(templateFor('x.yaml')).toContain('baseUrl: ${env.BASE_URL}');
  });
  it('finds steps by engine step id through groups', () => {
    const script = { steps: [{ goto: '/' }, { group: { name: 'g', steps: [{ click: { target: { text: 'a' } } }, { wait: { ms: 1 } }] } }] };
    expect(stepById(script, '1')).toEqual({ goto: '/' });
    expect(stepById(script, '2.2')).toEqual({ wait: { ms: 1 } });
    expect(stepById(script, '3')).toBeUndefined();
    expect(stepById(null, '1')).toBeUndefined();
  });
});

describe('run files', () => {
  it('flattens run.json steps (group children) by step id', () => {
    const map = flattenRunJsonSteps([
      { stepId: '1', status: 'passed', durationMs: 5, screenshot: 'screenshots/1.png' },
      { stepId: '2', status: 'failed', durationMs: 7, children: [{ stepId: '2.1', status: 'failed', durationMs: 3, error: 'x' }] },
    ]);
    expect(Object.keys(map)).toEqual(['1', '2', '2.1']);
    expect(map['1']!.screenshot).toBe('screenshots/1.png');
  });
  it('picks console errors/warnings and failed requests out of steps.jsonl', () => {
    const lines = [
      JSON.stringify({ type: 'console.message', level: 'log', text: 'hi' }),
      JSON.stringify({ type: 'console.message', level: 'error', text: 'boom', stepId: '3' }),
      JSON.stringify({ type: 'network.failed', url: 'https://a/api', method: 'GET', status: 500, stepId: '3' }),
      'not json',
      JSON.stringify({ type: 'step.finished', stepId: '3' }),
    ].join('\n');
    expect(parseEventLog(lines)).toEqual({
      console: [{ level: 'error', text: 'boom', stepId: '3' }],
      network: [{ url: 'https://a/api', method: 'GET', status: 500, stepId: '3' }],
    });
  });
  it('precheck problems read in Korean with names / script', () => {
    expect(problemText({ code: 'CREDENTIALS_MISSING', message: 'x', names: ['A', 'B'], script: 's.yaml' })).toBe('환경에 없는 테스트 계정: A, B (s.yaml)');
  });
});

describe('format', () => {
  it('parses KEY=value lines and reports bad ones', () => {
    expect(parseKeyValues('a=1\n# c\n\n b = x y \nbad line\n1x=2')).toEqual({ values: { a: '1', b: 'x y' }, bad: ['bad line', '1x=2'] });
  });
  it('describes cadences', () => {
    expect(cadenceText({ kind: 'weekly', dayOfWeek: 1, time: '09:30' })).toBe('매주 월 09:30');
    expect(cadenceText({ kind: 'hourly', minute: 5 })).toBe('매시간 5분');
    expect(cadenceText({ kind: 'cron', expression: '*/30 9-18 * * 1-5' })).toBe('cron: */30 9-18 * * 1-5');
  });
  it('Korean editor messages', () => {
    expect(friendly('steps[0].wait.ms: must match pattern ^\\d+(ms|s|m)$')).toBe('시간 형식이 아닙니다 (예: 500, 2s, 1m)');
    expect(koSecretRule('steps[1].goto: ${secrets.A} is only allowed in the value of a fill or type step')).toContain('입력 스텝');
  });
});

describe('copied editor model + step diff (euta-app parity)', () => {
  const script = { version: 1, name: 'n', steps: [{ goto: '/a' }, { click: { target: { text: 'x' } } }, { wait: { ms: 1 } }] };
  it('keeps source paths for untouched steps; new steps have none', () => {
    let m = toModel(script);
    m = addStep(m, [3], { goto: '/z' });
    m = moveDown(m, [0]);
    const p = toPayload(m);
    expect(p.steps.map((s) => s.src ?? null)).toEqual([['steps', 1], ['steps', 0], ['steps', 2], null]);
    expect(p.header).toEqual({ version: 1, name: 'n' });
  });
  it('group in / out and form edits', () => {
    let m = groupIn(toModel(script), [1]);
    expect(flatten(m).map((f) => f.path.join('.'))).toEqual(['0', '1', '1.0', '2']);
    m = groupOut(m, [1, 0]);
    m = setStep(m, [0], { goto: '/b' });
    expect((fromModel(m).steps as unknown[])[0]).toEqual({ goto: '/b' });
  });
  it('maps validation paths to step paths', () => {
    expect(issueStepPath('steps[2].group.steps[0].click.target')).toEqual([2, 0]);
    expect(issueStepPath('name')).toBeUndefined();
  });
  it('diffs as step sentences with "changed" pairs', () => {
    const after = { ...script, steps: [{ goto: '/b' }, { click: { target: { text: 'x' } } }, { wait: { ms: 1 } }, { goto: '/c' }] };
    const d = diffScripts(script, after);
    expect(d.summary).toBe('단계 1개 추가, 1개 변경');
    expect(d.rows.map((r) => r.kind)).toEqual(['changed', 'same', 'same', 'added']);
    expect(diffScripts(undefined, script).summary).toBe('처음 기록 (단계 3개)');
  });
});
