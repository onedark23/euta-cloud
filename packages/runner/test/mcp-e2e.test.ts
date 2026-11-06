// Remote MCP end to end: an MCP client (official SDK, Streamable HTTP) saves a script, runs it on a
// real runner + engine (Chromium) against the engine fixture site, polls get_run to the end and
// reads the step screenshot and run.log — with no credential value in any tool result.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_USER, startFixtureServer, type FixtureServer } from '../../../../euta-engine/packages/core/test/fixture-site/server.js';
import { TEST_RUNNER_TOKEN, TestEnv } from '../../server/test/helpers.js';
import { issueToken, McpRecorder, type McpSession } from '../../server/test/mcp-helpers.js';
import { projectFixture, type ProjectFixture } from '../../server/test/run-helpers.js';
import { loadRunnerConfig } from '../src/config.js';
import { jsonLogger } from '../src/log.js';
import { startRunner, type RunnerHandle } from '../src/runner.js';

const LOGIN = `version: 1
name: MCP login
target:
  baseUrl: \${env.BASE_URL}
defaults: { timeout: 5s }
steps:
  - goto: /login
  - fill: { target: { label: 이메일 }, value: "\${secrets.USER_EMAIL}" }
  - fill: { target: { label: 비밀번호 }, value: "\${secrets.USER_PASSWORD}" }
  - click: { target: { role: button, name: 로그인 } }
  - expect: { url: /dashboard }
`;

describe('remote MCP E2E (MCP client → server → runner → engine → fixture site)', () => {
  let env: TestEnv;
  let site: FixtureServer;
  let f: ProjectFixture;
  let runner: RunnerHandle;
  let mcp: McpSession;
  const rec = new McpRecorder();
  const runnerLogs: string[] = [];

  beforeAll(async () => {
    site = await startFixtureServer();
    env = await TestEnv.create({ config: { allowPrivateTargets: true, runnerHeartbeatMs: 1000, logLevel: 'info' } });
    const { publicUrl, internalUrl } = await env.listen();
    f = await projectFixture(env, { baseUrl: site.url, credentials: { USER_EMAIL: FIXTURE_USER.email, USER_PASSWORD: FIXTURE_USER.password } });
    const cfg = {
      ...loadRunnerConfig({ EUTA_SERVER_URL: internalUrl, EUTA_RUNNER_TOKEN: TEST_RUNNER_TOKEN, RUNNER_ID: 'mcp-e2e-runner', RUNNER_LOCATION: 'test-lab' }),
      workDir: mkdtempSync(join(tmpdir(), 'euta-runner-work-')),
      claimWaitMs: 2000,
      retryBaseMs: 200,
    };
    runner = startRunner(cfg, jsonLogger((l) => void runnerLogs.push(l)));
    mcp = await rec.connect(publicUrl, (await issueToken(env, f.editor.cookie, 'claude', 'read_write')).token);
  });
  afterAll(async () => {
    await mcp?.close().catch(() => undefined);
    await runner?.stop();
    await env?.close();
    await site?.close();
  });

  it('save_script → run_script → get_run until passed → screenshot + log', async () => {
    const saved = await mcp.call('save_script', { projectId: f.pid, path: 'mcp/login.yaml', source: LOGIN, memo: 'MCP E2E' });
    expect(saved.data).toMatchObject({ saved: true, created: true, version: 1 });
    const read = await mcp.call('read_script', { projectId: f.pid, path: 'mcp/login.yaml' });
    expect(read.data.steps).toHaveLength(5);

    const queued = await mcp.call('run_script', { projectId: f.pid, scriptPath: 'mcp/login.yaml' });
    expect(queued.isError).toBe(false);
    const runId = queued.data.runId as string;
    const seen = new Set<string>();
    let run: any;
    const end = Date.now() + 90_000;
    while (Date.now() < end) {
      run = (await mcp.call('get_run', { runId })).data;
      seen.add(run.status);
      if (!['queued', 'leased', 'running'].includes(run.status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(run).toMatchObject({ status: 'passed', source: 'ai_mcp', requestedBy: 'AI — editor (claude)', resultFiles: 'present', summary: { total: 5, passed: 5 } });
    expect(run.steps.map((s: { action: string }) => s.action)).toEqual(['goto', 'fill', 'fill', 'click', 'expect']);
    expect(run.files).toContain('run.log');

    const shot = await mcp.call('get_screenshot', { runId, stepId: '5' });
    expect(shot.isError).toBe(false);
    expect(shot.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(shot.content[1]!.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const log = await mcp.call('get_artifact', { runId, file: 'run.log' });
    expect(log.isError).toBe(false);
    expect(log.content[1]!.text!.length).toBeGreaterThan(0);
    const listed = await mcp.call('list_runs', { projectId: f.pid, target: 'mcp/login.yaml' });
    expect(listed.data[0]).toMatchObject({ id: runId, status: 'passed' });

    const all = rec.results.join('\n');
    for (const v of [FIXTURE_USER.email, FIXTURE_USER.password, encodeURIComponent(FIXTURE_USER.email)]) {
      expect(all).not.toContain(v);
      expect(env.logs.join('\n')).not.toContain(v);
    }
  });
});
