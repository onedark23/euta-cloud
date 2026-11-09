// Minimum app version (SPEC_앱-배포-업데이트 "최소 앱 버전"): requests authenticated with an app device
// token (a session token sent as `Authorization: Bearer`, not a `euta_` personal token) must carry
// `X-Euta-App-Version` ≥ MIN_APP_VERSION, else 426 APP_TOO_OLD. Web sessions (cookie), MCP personal
// tokens and runners (internal listener) are not checked; /api/auth/* and /api/app/* sit outside the
// checked scope so an old app can still sign in and find the new version.
import type { FastifyReply, FastifyRequest } from 'fastify';
import semver from 'semver';
import type { AppContext } from '../context.js';
import { errorBody } from '../http.js';

export const APP_VERSION_HEADER = 'x-euta-app-version';

function isDeviceToken(req: FastifyRequest): boolean {
  const authz = req.headers.authorization;
  if (typeof authz !== 'string' || !/^Bearer\s+/i.test(authz)) return false;
  return req.principal?.via === 'session' && !authz.replace(/^Bearer\s+/i, '').trim().startsWith('euta_');
}

/** True when the app is older than MIN_APP_VERSION (missing or non-SemVer header counts as older). */
export function appTooOld(min: string, header: unknown): boolean {
  const v = typeof header === 'string' ? semver.valid(header.trim()) : null;
  return !v || semver.lt(v, min);
}

/** onRequest check after authentication; sends the 426 itself and returns true when it did. */
export function rejectOldApp(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): boolean {
  const min = ctx.config.minAppVersion;
  if (!min || !isDeviceToken(req) || !appTooOld(min, req.headers[APP_VERSION_HEADER])) return false;
  void reply.status(426).send({
    code: 'APP_TOO_OLD',
    minVersion: min,
    ...errorBody('APP_TOO_OLD', `this app version is no longer supported by euta cloud — update the app to ${min} or later`, { minVersion: min }),
  });
  return true;
}
