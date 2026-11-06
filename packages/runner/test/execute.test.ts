// Engine child process setup: clean environment (no runner token), argument list, redaction.
import type { ClaimedRun } from '@euta-cloud/shared';
import { describe, expect, it } from 'vitest';
import { childEnv, engineArgs } from '../src/execute.js';
import { redactor } from '../src/log.js';

const run: ClaimedRun = {
  runId: 'r1',
  projectId: 'p1',
  scriptName: 'login.yaml',
  scriptSource: 'version: 1',
  contentHash: 'h',
  environment: { id: 'e1', name: 'dev', baseUrl: 'https://dev.example.com', vars: { LANDING: '/home', PATH: '/evil', NODE_OPTIONS: '--require /x', EUTA_RUNNER_TOKEN: 'x' }, allowedDomains: ['dev.example.com', 'sso.example.com'] },
  vars: { mode: 'quick', n: 3 },
  browser: 'firefox',
  device: 'iPhone 13',
  timeLimitMs: 60_000,
  record: { video: 'on-failure', trace: 'on-failure' },
  credentialNames: ['USER_EMAIL'],
  leaseExpiresAt: new Date().toISOString(),
  heartbeatMs: 5000,
};

describe('engine child process', () => {
  it('passes only the run environment and what Node/Playwright need — never the runner token', () => {
    process.env.EUTA_RUNNER_TOKEN = 'runner-token-must-not-leak';
    process.env.EUTA_SERVER_URL = 'http://internal:8081';
    try {
      const { env, dropped } = childEnv(run, '/tmp/x');
      expect(env.BASE_URL).toBe('https://dev.example.com');
      expect(env.LANDING).toBe('/home');
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(Object.values(env)).not.toContain('runner-token-must-not-leak');
      expect(env.EUTA_SERVER_URL).toBeUndefined();
      expect(dropped.sort()).toEqual(['EUTA_RUNNER_TOKEN', 'NODE_OPTIONS', 'PATH']);
    } finally {
      delete process.env.EUTA_RUNNER_TOKEN;
      delete process.env.EUTA_SERVER_URL;
    }
  });

  it('builds the cloud CLI invocation', () => {
    expect(engineArgs(run, { script: '/t/login.yaml', runsDir: '/t/runs', baselineDir: '/t/b', secrets: '/t/secrets.json' })).toEqual([
      'run', '/t/login.yaml', '--runs-dir', '/t/runs', '--baseline-dir', '/t/b', '--cloud', '--quiet',
      '--secrets', '/t/secrets.json', '--allowed-domains', 'dev.example.com,sso.example.com', '--browser', 'firefox', '--device', 'iPhone 13', '--var', 'mode=quick', '--var', 'n=3',
    ]);
    const bare = engineArgs({ ...run, environment: { ...run.environment, allowedDomains: [] }, browser: null, device: null, vars: {} }, { script: 's', runsDir: 'r', baselineDir: 'b', secrets: null });
    expect(bare).toEqual(['run', 's', '--runs-dir', 'r', '--baseline-dir', 'b', '--cloud', '--quiet']);
  });

  it('redacts secret values and their URL encodings', () => {
    const r = redactor(['p@ss word!', 'ab']);
    expect(r('x p@ss word! y p%40ss%20word! ab')).toBe('x *** y *** ab');
  });
});
