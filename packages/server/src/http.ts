// Error envelope and request parsing helpers.
import type { ApiErrorBody } from '@euta-cloud/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import * as z from 'zod';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what = 'resource') => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (message = 'you do not have permission for this action') => new AppError(403, 'FORBIDDEN', message);
export const unauthenticated = (message = 'sign in required') => new AppError(401, 'UNAUTHENTICATED', message);

/**
 * Validate input with a zod schema → 422 with `{ path, message }` issues only (never echoes the
 * input value, so a credential value in a bad request cannot leak through the error).
 */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  throw new AppError(
    422,
    'VALIDATION_FAILED',
    'request validation failed',
    r.error.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
  );
}

export function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

export function errorHandler(err: FastifyError | AppError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof AppError) {
    return reply.status(err.status).send(errorBody(err.code, err.message, err.details));
  }
  const fe = err as FastifyError;
  if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
    const code = fe.statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : fe.statusCode === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'BAD_REQUEST';
    return reply.status(fe.statusCode).send(errorBody(code, fe.message));
  }
  req.log.error({ err: { message: err.message, stack: err.stack } }, 'unhandled error');
  return reply.status(500).send(errorBody('INTERNAL', 'internal server error'));
}
