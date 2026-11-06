// Server entry: config → migrations → app → listen; hourly purge job.
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { runMigrations } from './db/index.js';
import { purgeExpired } from './services/purge.js';
import { purgeResults } from './services/result-retention.js';
import { sweepRuns } from './services/run-queue.js';
import { sendPendingNotifications } from './services/notify.js';
import { SCHEDULER_TICK_MS, tickSchedules } from './services/scheduler.js';

const config = loadConfig();
await runMigrations(config.databaseUrl);
const { app, internal, ctx } = await buildApp(config);
if (ctx.approvalMode) app.log.warn('SMTP_URL is not set — sign-ups wait for administrator approval');

if (!config.runnerToken) app.log.warn('RUNNER_TOKEN is not set — the internal runner API refuses all requests');
if (config.allowPrivateTargets) app.log.warn('ALLOW_PRIVATE_TARGETS=true — public-address precheck is OFF (dev/test only, never in a deployment)');

const hourly = async () => {
  app.log.info(await purgeExpired(ctx), 'purge done');
  app.log.info(await purgeResults(ctx), 'result retention done');
};
const timer = setInterval(() => {
  hourly().catch((err: Error) => app.log.error({ err: { message: err.message } }, 'purge failed'));
}, 60 * 60 * 1000);
timer.unref();
// Run sweeper: expired leases → aborted, time limits → stop request / timeout.
const sweeper = setInterval(() => {
  sweepRuns(ctx)
    .then((r) => {
      if (r.aborted || r.timeoutRequested || r.timedOut) app.log.info(r, 'run sweep');
    })
    .catch((err: Error) => app.log.error({ err: { message: err.message } }, 'run sweep failed'));
}, 15_000);
sweeper.unref();
// Scheduler (ADR-020 §3): one instance per tick holds the advisory lock.
const scheduler = setInterval(() => {
  tickSchedules(ctx)
    .then((r) => {
      if (r.fired || r.errors || r.skipped.overlap || r.skipped.missed || r.skipped['daily-cap']) app.log.info(r, 'schedule tick');
    })
    .catch((err: Error) => app.log.error({ err: { message: err.message } }, 'schedule tick failed'));
}, SCHEDULER_TICK_MS);
scheduler.unref();
// Teams outbox: woken by NOTIFY euta_notify, plus a poll for retries (backoff) and missed wake-ups.
let sending = false;
let again = false;
const sendNotifications = (): void => {
  if (sending) {
    again = true;
    return;
  }
  sending = true;
  again = false;
  sendPendingNotifications(ctx)
    .then((r) => {
      if (r.sent || r.failed || r.retried) app.log.info(r, 'notifications sent');
    })
    .catch((err: Error) => app.log.error({ err: { message: err.message } }, 'notification send failed'))
    .finally(() => {
      sending = false;
      if (again) sendNotifications();
    });
};
const offNotify = ctx.feed.onSignal('euta_notify', sendNotifications);
const notifier = setInterval(sendNotifications, 15_000);
notifier.unref();

const shutdown = async () => {
  clearInterval(timer);
  clearInterval(sweeper);
  clearInterval(scheduler);
  clearInterval(notifier);
  offNotify();
  await internal.close();
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await internal.listen({ host: config.host, port: config.internalPort });
await app.listen({ host: config.host, port: config.port });
