// HTTP client for the server's internal runner API (SPEC 러너 프로토콜).
import type { Readable } from 'node:stream';
import type { ClaimedRun, EventsResponse, FinishRequest } from '@euta-cloud/shared';
import type { RunnerConfig } from './config.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ServerClient {
  constructor(private readonly cfg: Pick<RunnerConfig, 'serverUrl' | 'token' | 'runnerId'>) {}

  private async call(method: string, path: string, init: { json?: unknown; body?: Readable; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.cfg.token}`, 'x-euta-runner-id': this.cfg.runnerId, ...(init.headers ?? {}) };
    let body: unknown;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.body) {
      headers['content-type'] = 'application/x-tar';
      body = init.body;
    }
    const res = await fetch(`${this.cfg.serverUrl}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(init.body ? { duplex: 'half' } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    } as RequestInit);
    if (res.status >= 400) {
      let code = `HTTP_${res.status}`;
      let message = res.statusText;
      try {
        const j = (await res.json()) as { error?: { code?: string; message?: string } };
        code = j.error?.code ?? code;
        message = j.error?.message ?? message;
      } catch {
        /* not JSON */
      }
      throw new HttpError(res.status, code, message);
    }
    return res;
  }

  async claim(location: string, slots: number, waitMs: number, signal?: AbortSignal): Promise<ClaimedRun | null> {
    const res = await this.call('POST', '/internal/runner/claim', { json: { runnerId: this.cfg.runnerId, location, slots, waitMs }, ...(signal ? { signal } : {}) });
    if (res.status === 204) return null;
    return (await res.json()) as ClaimedRun;
  }

  /** One-time credential values for the run. The caller writes them to a 0600 file and forgets them. */
  async credentials(runId: string): Promise<Record<string, string>> {
    const res = await this.call('POST', `/internal/runs/${runId}/credentials`, { json: { runnerId: this.cfg.runnerId } });
    return ((await res.json()) as { secrets: Record<string, string> }).secrets;
  }

  async events(runId: string, events: unknown[], engineRunId?: string): Promise<EventsResponse> {
    const res = await this.call('POST', `/internal/runs/${runId}/events`, { json: { runnerId: this.cfg.runnerId, events, ...(engineRunId ? { engineRunId } : {}) } });
    return (await res.json()) as EventsResponse;
  }

  async uploadResult(runId: string, tar: Readable): Promise<void> {
    await (await this.call('PUT', `/internal/runs/${runId}/result`, { body: tar })).arrayBuffer();
  }

  async finish(runId: string, body: Omit<FinishRequest, 'runnerId'>): Promise<void> {
    await (await this.call('POST', `/internal/runs/${runId}/finish`, { json: { runnerId: this.cfg.runnerId, ...body } })).arrayBuffer();
  }

  async downloadBaselines(runId: string): Promise<ReadableStream<Uint8Array> | null> {
    const res = await this.call('GET', `/internal/runs/${runId}/baselines`);
    return res.body;
  }

  async uploadBaselines(runId: string, tar: Readable): Promise<void> {
    await (await this.call('PUT', `/internal/runs/${runId}/baselines`, { body: tar })).arrayBuffer();
  }
}
