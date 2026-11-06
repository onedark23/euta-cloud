// JSON fetch against the same-origin server. Errors carry the euta code (`error.code`), the
// Better Auth code (`code`) or the RFC 8628 code (`error: "expired_token"`), whichever is present,
// plus the euta `error.details` (validation issues, conflict info, precheck problems).

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const code: string =
      (typeof data?.error === 'object' && data.error?.code) || data?.code || (typeof data?.error === 'string' ? data.error : '') || `HTTP_${res.status}`;
    const message: string = (typeof data?.error === 'object' && data.error?.message) || data?.message || data?.error_description || res.statusText;
    throw new ApiError(res.status, code, message, typeof data?.error === 'object' ? data.error?.details : undefined);
  }
  return data as T;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
