// Better Auth setup (ADR-023): company-domain sign-up, email verification (or admin approval when
// SMTP is not configured), login lockout, 7-day cookie sessions, personal tokens (api-key plugin),
// device authorization (local app) + bearer (device-issued session tokens).
// Microsoft (Entra ID) login when configured (ADR-041): company tenant only, first login = active
// account, new email sign-ups closed, existing same-email accounts linked.
import { apiKey } from '@better-auth/api-key';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { PASSWORD_MAX, PASSWORD_MIN, TOKEN_DEFAULT_EXPIRY_DAYS, TOKEN_EXPIRY_DAYS, TOKEN_PREFIX } from '@euta-cloud/shared';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { bearer, deviceAuthorization } from 'better-auth/plugins';
import { and, eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { accounts, authSchema, loginAttempts, users } from './db/schema.js';
import type { Mailer } from './mail.js';

export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_MS = 10 * 60 * 1000;
export const SESSION_DAYS = 7;
const DAY_S = 24 * 60 * 60;

export interface AuthOptions {
  config: Config;
  db: Db;
  clock: Clock;
  /** null → admin-approval mode (no verification mail). */
  mailer: Mailer | null;
  /** Better Auth's own log lines go to the server log (one sink, same redaction and capture). */
  log: FastifyBaseLogger;
}

export const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

export function isAllowedEmail(config: Config, email: unknown): boolean {
  return typeof email === 'string' && email.includes('@') && config.allowedEmailDomains.includes(emailDomain(email));
}

export const MICROSOFT = 'microsoft';

/** Claims of the Entra v2 id token we use. */
interface EntraIdClaims {
  sub: string;
  tid?: string;
  name?: string;
  email?: string;
  preferred_username?: string;
}

function decodeJwtPayload(token: string): EntraIdClaims {
  const part = token.split('.')[1];
  if (!part) throw new Error('malformed id token');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as EntraIdClaims;
}

/**
 * User info from the id token only (no Graph call — no User.Read, no photo). The token comes straight
 * from the company tenant's token endpoint over TLS; the tenant is re-checked anyway. Company accounts
 * may lack the optional `email` claim → fall back to the UPN (`preferred_username`). The tenant manages
 * these addresses, so they count as verified (needed to link an existing same-email account).
 */
export function entraUserInfo(idToken: string | undefined, tenantId: string) {
  if (!idToken) return null;
  const c = decodeJwtPayload(idToken);
  if (c.tid?.toLowerCase() !== tenantId.toLowerCase()) return null;
  const email = (c.email || c.preferred_username || '').toLowerCase();
  return { user: { id: c.sub, name: c.name || email.split('@')[0] || '', email, emailVerified: true }, data: c };
}

export function createAuth({ config, db, clock, mailer, log }: AuthOptions) {
  const approvalMode = mailer === null;
  const ms = config.microsoft;
  const domainError = () =>
    new APIError('FORBIDDEN', {
      code: 'EMAIL_DOMAIN_NOT_ALLOWED',
      message: `sign-up is limited to ${config.allowedEmailDomains.map((d) => '@' + d).join(', ')} addresses`,
    });

  return betterAuth({
    appName: 'euta cloud',
    baseURL: config.baseUrl,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [config.baseUrl],
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    telemetry: { enabled: false },
    logger: {
      level: config.logLevel === 'debug' || config.logLevel === 'trace' ? 'debug' : 'info',
      log: (level, message, ...args) => {
        const detail = args.map((a) => (a instanceof Error ? { error: a.message } : a));
        log[level]({ component: 'better-auth', ...(detail.length ? { args: detail } : {}) }, message);
      },
    },
    rateLimit: { enabled: config.rateLimit },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN,
      maxPasswordLength: PASSWORD_MAX,
      // Never create a session at sign-up: verification (SMTP mode) or approval comes first.
      autoSignIn: false,
      // Microsoft login on → new accounts only through it; email/password stays for existing members.
      disableSignUp: ms !== null,
      requireEmailVerification: !approvalMode,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      ...(mailer
        ? {
            sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
              await mailer.send({ to: user.email, subject: 'euta cloud 비밀번호 재설정', text: `아래 링크에서 비밀번호를 다시 정하세요 (1시간 유효).\n\n${url}\n` });
            },
          }
        : {}),
    },
    ...(mailer
      ? {
          emailVerification: {
            sendOnSignUp: true,
            // A sign-in attempt by an unverified user re-sends the mail (SPEC 메일 인증).
            sendOnSignIn: true,
            autoSignInAfterVerification: false,
            expiresIn: DAY_S,
            sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
              await mailer.send({ to: user.email, subject: 'euta cloud 메일 인증', text: `아래 링크를 눌러 메일 주소를 인증하세요 (24시간 유효).\n\n${url}\n` });
            },
          },
        }
      : {}),
    ...(ms
      ? {
          socialProviders: {
            microsoft: {
              clientId: ms.clientId,
              clientSecret: ms.clientSecret,
              tenantId: ms.tenantId,
              // Sign-in scopes only ("openid profile email") — no Graph permission to consent to.
              disableDefaultScope: true,
              scope: ['openid', 'profile', 'email'],
              prompt: 'select_account' as const,
              getUserInfo: async (token: { idToken?: string }) => entraUserInfo(token.idToken, ms.tenantId),
            },
          },
          // Unverified local accounts may link too — the account hook below drops their password first.
          account: { accountLinking: { enabled: true, trustedProviders: [MICROSOFT], requireLocalEmailVerified: false } },
        }
      : {}),
    session: {
      expiresIn: SESSION_DAYS * DAY_S,
      updateAge: DAY_S, // extended while in use
      // No cookie cache: deactivation / logout must take effect on the next request.
      cookieCache: { enabled: false },
    },
    user: {
      additionalFields: {
        status: { type: 'string', required: false, input: false, defaultValue: 'active' },
        isAdmin: { type: 'boolean', required: false, input: false, defaultValue: false },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-up/email') {
          if (!isAllowedEmail(config, ctx.body?.email)) throw domainError();
        }
        if (ctx.path === '/sign-in/email' && typeof ctx.body?.email === 'string') {
          const email = ctx.body.email.toLowerCase();
          const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.email, email));
          if (row?.lockedUntil && row.lockedUntil.getTime() > clock.now().getTime()) {
            throw new APIError('TOO_MANY_REQUESTS', {
              code: 'ACCOUNT_LOCKED',
              message: `too many failed sign-in attempts — try again after ${row.lockedUntil.toISOString()}`,
            });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email' || typeof ctx.body?.email !== 'string') return;
        const email = ctx.body.email.toLowerCase();
        const returned = ctx.context.returned;
        const now = clock.now();
        if (isAPIError(returned)) {
          // Only wrong credentials count (401). Unverified (403) / pending / locked do not.
          if (returned.statusCode !== 401) return;
          const [row] = await db.select().from(loginAttempts).where(eq(loginAttempts.email, email));
          const failures = (row?.failures ?? 0) + 1;
          const lock = failures >= LOCKOUT_FAILURES;
          const values = { failures: lock ? 0 : failures, lockedUntil: lock ? new Date(now.getTime() + LOCKOUT_MS) : (row?.lockedUntil ?? null), updatedAt: now };
          await db.insert(loginAttempts).values({ email, ...values }).onConflictDoUpdate({ target: loginAttempts.email, set: values });
        } else {
          await db.delete(loginAttempts).where(eq(loginAttempts.email, email));
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const email = String(user.email).toLowerCase();
            if (!isAllowedEmail(config, email)) throw domainError();
            const isAdmin = config.adminEmails.includes(email);
            // Approval mode: everyone but configured admins waits for an admin — unless Microsoft login
            // is on, where the only way in is a company-tenant account (active at once).
            const status = approvalMode && !ms && !isAdmin ? 'pending' : 'active';
            return { data: { ...user, email, isAdmin, status } };
          },
        },
      },
      account: {
        create: {
          // Linking Microsoft to an existing account. `before`, not `after`: Better Auth defers `after`
          // hooks to the end of the request, i.e. past the session check below. A brand-new Microsoft
          // user is still uncommitted here, so it is not found and the user hook above already set it.
          // An account whose email was never proven (pending approval / unverified mail) may have been
          // registered by someone else with a password they know: drop that password so only the
          // tenant-verified owner gets in. Configured administrators keep theirs (user decision
          // 2026-11-02, ADR-041). Then treat it like a new Microsoft user: verified, pending → active.
          // Deactivated stays deactivated.
          before: async (account) => {
            if (account.providerId !== MICROSOFT) return;
            const [u] = await db.select({ emailVerified: users.emailVerified, isAdmin: users.isAdmin }).from(users).where(eq(users.id, account.userId));
            if (!u) return;
            if (!u.emailVerified && !u.isAdmin) {
              await db.delete(accounts).where(and(eq(accounts.userId, account.userId), eq(accounts.providerId, 'credential')));
              await db.update(users).set({ emailVerified: true, updatedAt: clock.now() }).where(eq(users.id, account.userId));
            }
            await db.update(users).set({ status: 'active', updatedAt: clock.now() }).where(and(eq(users.id, account.userId), eq(users.status, 'pending')));
          },
        },
      },
      session: {
        create: {
          // Covers every way a session is born: email sign-in and device-token issuance.
          before: async (session) => {
            const [u] = await db.select({ status: users.status }).from(users).where(eq(users.id, session.userId));
            if (!u || u.status === 'active') return;
            if (u.status === 'pending') throw new APIError('FORBIDDEN', { code: 'PENDING_APPROVAL', message: 'your account is waiting for administrator approval' });
            throw new APIError('FORBIDDEN', { code: 'ACCOUNT_DEACTIVATED', message: 'this account has been deactivated' });
          },
        },
      },
    },
    plugins: [
      bearer(),
      deviceAuthorization({
        verificationUri: `${config.baseUrl}/device`,
        expiresIn: '15m',
        interval: '5s',
        validateClient: (clientId: string) => config.deviceClientIds.includes(clientId),
      }),
      apiKey({
        defaultPrefix: TOKEN_PREFIX,
        defaultKeyLength: 48,
        requireName: true,
        maximumNameLength: 40,
        // "euta_" + 4 characters shown in the token list (SPEC 개인 토큰 "앞 4자리").
        startingCharactersConfig: { shouldStore: true, charactersLength: TOKEN_PREFIX.length + 4 },
        keyExpiration: {
          defaultExpiresIn: TOKEN_DEFAULT_EXPIRY_DAYS * DAY_S,
          minExpiresIn: Math.min(...TOKEN_EXPIRY_DAYS),
          maxExpiresIn: Math.max(...TOKEN_EXPIRY_DAYS),
        },
        // SPEC_클라우드-MCP: 120 calls per token per minute.
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 120 },
        enableSessionForAPIKeys: false,
        disableKeyHashing: false,
        permissions: { defaultPermissions: { project: ['read'] } },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
