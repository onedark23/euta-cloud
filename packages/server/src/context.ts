import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import type { Auth } from './auth.js';
import type { Clock } from './clock.js';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import type { Mailer } from './mail.js';
import type { HostResolver } from './services/address-check.js';
import type { AppMirror } from './services/app-mirror.js';
import type { ChangeFeed } from './services/feed.js';
import type { FetchLike } from './services/notify.js';
import type { ResultStore } from './services/result-store.js';

export interface AppContext {
  config: Config;
  db: Db;
  pool: pg.Pool;
  auth: Auth;
  feed: ChangeFeed;
  /** Result files + visual baselines (ADR-021). */
  results: ResultStore;
  clock: Clock;
  resolveHost: HostResolver;
  mailer: Mailer | null;
  /** No SMTP → sign-ups wait for admin approval. */
  approvalMode: boolean;
  log: FastifyBaseLogger;
  /** Outbound HTTP for Teams webhooks (tests inject a fake). */
  fetch: FetchLike;
  /** GitHub release mirror (ADR-048); null → APP_MIRROR_GITHUB unset. Timers are started by main.ts. */
  mirror: AppMirror | null;
}
