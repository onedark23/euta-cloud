// Remote MCP test client: the official SDK client over Streamable HTTP against a listening server.
// Every tool result is recorded (`McpRecorder.results`) for the plaintext-credential scans.
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { TestEnv } from './helpers.js';

export interface ToolCall {
  isError: boolean;
  /** Parsed first text block (JSON) — the tool's main result. */
  data: any;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

export class McpRecorder {
  readonly results: string[] = [];

  async connect(baseUrl: string, token: string): Promise<McpSession> {
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
    const client = new Client({ name: 'euta-cloud-test', version: '0.0.0' });
    await client.connect(transport);
    return new McpSession(client, this);
  }
}

export class McpSession {
  constructor(
    readonly client: Client,
    private readonly rec: McpRecorder,
  ) {}

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
    const r = (await this.client.callTool({ name, arguments: args })) as { isError?: boolean; content: ToolCall['content'] };
    this.rec.results.push(`${name} ${JSON.stringify(r)}`);
    const first = r.content.find((c) => c.type === 'text')?.text ?? 'null';
    let data: unknown;
    try {
      data = JSON.parse(first);
    } catch {
      data = first;
    }
    return { isError: !!r.isError, data, content: r.content };
  }

  close() {
    return this.client.close();
  }
}

/** Issue a personal token for a signed-in user (session cookie). */
export async function issueToken(env: TestEnv, cookie: string, name: string, permission: 'read' | 'read_write'): Promise<{ id: string; token: string }> {
  const r = await env.req('POST', '/api/me/tokens', { cookie, body: { name, permission } });
  if (r.status !== 201) throw new Error(`token issue failed ${r.status} ${r.text}`);
  return { id: r.body.id, token: r.body.token };
}

/** Raw POST to /mcp (status / header checks) — a JSON-RPC tools/list. */
export async function rawMcpPost(baseUrl: string, headers: Record<string, string>): Promise<Response> {
  return fetch(new URL('/mcp', baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}
