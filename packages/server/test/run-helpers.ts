// Helpers for run tests: a project with owner/editor/viewer, an environment with credentials,
// script saving, and a fake runner speaking the internal protocol.
import * as tar from 'tar-stream';
import { TestEnv } from './helpers.js';

export const SIMPLE_SCRIPT = (name = 'Simple', extra = '') => `version: 1
name: ${name}
target:
  baseUrl: \${env.BASE_URL}
steps:
  - goto: /
${extra}`;

export const CRED_SCRIPT = (cred: string, name = 'Cred') => `version: 1
name: ${name}
target:
  baseUrl: \${env.BASE_URL}
steps:
  - goto: /login
  - fill: { target: { label: 이메일 }, value: "\${secrets.${cred}}" }
`;

export interface ProjectFixture {
  owner: { id: string; cookie: string };
  editor: { id: string; cookie: string };
  viewer: { id: string; cookie: string };
  pid: string;
  envId: string;
}

export async function projectFixture(env: TestEnv, opts: { baseUrl?: string; credentials?: Record<string, string> } = {}): Promise<ProjectFixture> {
  const owner = await env.user('owner@example.com');
  const editor = await env.user('editor@example.com');
  const viewer = await env.user('viewer@example.com');
  const pid = (await env.req('POST', '/api/projects', { cookie: owner.cookie, body: { name: 'Runs' } })).body.id as string;
  await env.req('PUT', `/api/projects/${pid}/members/${editor.id}`, { cookie: owner.cookie, body: { role: 'editor' } });
  const e = await env.req('POST', `/api/projects/${pid}/environments`, {
    cookie: owner.cookie,
    body: { name: 'dev', baseUrl: opts.baseUrl ?? 'https://dev.example.com', makeDefault: true },
  });
  if (e.status !== 201) throw new Error(`env create failed ${e.text}`);
  for (const [k, v] of Object.entries(opts.credentials ?? {})) {
    await env.req('PUT', `/api/projects/${pid}/environments/${e.body.id}/credentials/${k}`, { cookie: owner.cookie, body: { value: v } });
  }
  return { owner, editor, viewer, pid, envId: e.body.id as string };
}

export async function saveScript(env: TestEnv, f: ProjectFixture, path: string, source: string, origin = 'web') {
  const cur = await env.req('GET', `/api/projects/${f.pid}/scripts/${path}`, { cookie: f.owner.cookie });
  const baseVersion = cur.status === 200 ? cur.body.version : undefined;
  const r = await env.req('PUT', `/api/projects/${f.pid}/scripts/${path}`, { cookie: f.owner.cookie, body: { source, origin, ...(baseVersion ? { baseVersion } : {}) } });
  if (r.status >= 300) throw new Error(`save failed ${r.status} ${r.text}`);
  return r.body;
}

export async function requestRun(env: TestEnv, f: ProjectFixture, body: Record<string, unknown>, cookie = f.editor.cookie) {
  return env.req('POST', `/api/projects/${f.pid}/runs`, { cookie, body });
}

/** Fake runner over the internal API. */
export class FakeRunner {
  constructor(
    private readonly env: TestEnv,
    readonly id = 'fake-runner-1',
    readonly location = 'test-lab',
  ) {}

  claim(slots = 1, waitMs = 0) {
    return this.env.ireq('POST', '/internal/runner/claim', { body: { runnerId: this.id, location: this.location, slots, waitMs } });
  }
  credentials(runId: string) {
    return this.env.ireq('POST', `/internal/runs/${runId}/credentials`, { body: { runnerId: this.id } });
  }
  events(runId: string, events: Record<string, unknown>[] = [], engineRunId?: string) {
    return this.env.ireq('POST', `/internal/runs/${runId}/events`, { body: { runnerId: this.id, events, ...(engineRunId ? { engineRunId } : {}) } });
  }
  upload(runId: string, payload: Buffer) {
    return this.env.ireq('PUT', `/internal/runs/${runId}/result`, { payload, headers: { 'content-type': 'application/x-tar', 'x-euta-runner-id': this.id } });
  }
  finish(runId: string, body: Record<string, unknown>) {
    return this.env.ireq('POST', `/internal/runs/${runId}/finish`, { body: { runnerId: this.id, ...body } });
  }
  /** Claim → running → upload → finish with the given status. */
  async complete(runId: string, status = 'passed', files: TarEntry[] = [{ name: 'run.json', body: '{}' }]) {
    await this.events(runId, [{ type: 'run.finished', seq: 1, status, summary: { total: 1, passed: status === 'passed' ? 1 : 0, failed: status === 'failed' ? 1 : 0, error: 0, skipped: 0 }, durationMs: 10 }]);
    const up = await this.upload(runId, await makeTar(files));
    if (up.status !== 200) throw new Error(`upload failed ${up.status} ${up.text}`);
    return this.finish(runId, { status });
  }
}

export interface TarEntry {
  name: string;
  body?: string | Buffer;
  type?: 'file' | 'directory' | 'symlink' | 'link';
  linkname?: string;
}

export function makeTar(entries: TarEntry[]): Promise<Buffer> {
  const pack = tar.pack();
  for (const e of entries) {
    if (e.type === 'symlink' || e.type === 'link') pack.entry({ name: e.name, type: e.type, linkname: e.linkname ?? '/etc/passwd' });
    else if (e.type === 'directory') pack.entry({ name: e.name, type: 'directory' });
    else pack.entry({ name: e.name }, e.body ?? '');
  }
  pack.finalize();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    pack.on('data', (c: unknown) => void chunks.push(c as Buffer));
    pack.on('end', () => resolve(Buffer.concat(chunks)));
    pack.on('error', reject);
  });
}
