// API error envelope: `{ error: { code, message, details? } }` (SPEC 계정·프로젝트 "API 개요").

export const ERROR_CODES = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SCRIPT_CONFLICT: 409,
  NAME_TAKEN: 409,
  LAST_OWNER: 409,
  TOKEN_LIMIT: 409,
  VALIDATION_FAILED: 422,
  SCRIPT_INVALID: 422,
  SCRIPT_TOO_LARGE: 422,
  YAML_PARSE_ERROR: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ApiErrorBody {
  error: { code: ErrorCode | string; message: string; details?: unknown };
}
