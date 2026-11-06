// Teams notifications (SPEC 알림). Mechanism: a Teams **Workflows** webhook ("Send webhook alerts to
// a channel" template / "When a Teams webhook request is received" trigger) — Office 365 connector
// webhooks were retired (May 2026). Body = `{ type: 'message', attachments: [Adaptive Card] }`.
// Outbox: rows are written in the run's terminal transaction and sent after commit by
// `sendPendingNotifications` (any server; `FOR UPDATE SKIP LOCKED`), with retry/backoff.
// A 2xx means "accepted" by the workflow, not "posted" — failures after that show only in the
// flow's run history. The webhook URL carries a SAS `sig`: never log it (host only).
import { and, asc, count, eq, gte, lte } from 'drizzle-orm';
import type { AppContext } from '../context.js';
import type { DbOrTx } from '../db/index.js';
import { notifications, projects } from '../db/schema.js';

export const NOTIFY_CHANNEL = 'euta_notify';
/** Delay before attempt n+1 (after n failed attempts); after the last one the row is `failed`. */
export const NOTIFY_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
export const NOTIFY_MAX_ATTEMPTS = NOTIFY_BACKOFF_MS.length + 1;
/** Workflows post action limit is 25 calls / 300 s per connection — stay under it per project. */
export const NOTIFY_MAX_PER_5MIN = 20;
const SEND_TIMEOUT_MS = 10_000;
const FIVE_MIN = 5 * 60_000;

export type NotificationKind = 'failure' | 'recovery' | 'passed' | 'flaky' | 'skipped' | 'aborted';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
}>;

export interface CardInput {
  kind: NotificationKind;
  projectName: string;
  target: string;
  environment: string;
  status: string;
  flaky: boolean;
  skipReason?: string | null;
  failedStep?: string | null;
  durationMs: number | null;
  scheduleName?: string | null;
  attempt: number;
  url: string;
}

const STATUS_KO: Record<string, string> = {
  passed: '통과',
  failed: '실패',
  error: '오류',
  timeout: '시간 초과',
  aborted: '중단',
  cancelled: '취소',
  skipped: '건너뜀',
};
const SKIP_KO: Record<string, string> = { overlap: '겹침', missed: '놓침', 'daily-cap': '일일 실행 상한' };

export function statusLabel(status: string, flaky: boolean, skipReason?: string | null): string {
  if (status === 'passed' && flaky) return '통과 · 불안정';
  if (status === 'skipped' && skipReason) return `건너뜀(${SKIP_KO[skipReason] ?? skipReason})`;
  return STATUS_KO[status] ?? status;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '-';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분 ${s % 60}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

const TITLE: Record<NotificationKind, string> = {
  failure: '실패',
  recovery: '회복',
  passed: '통과',
  flaky: '통과 · 불안정',
  skipped: '건너뜀',
  aborted: '중단',
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Teams Workflows webhook body with one Adaptive Card (1.4). Content = SPEC 알림 "내용": project,
 * target, environment, status, failing step sentence, duration, web run link — never credential
 * values, screenshots, HAR or variables.
 */
export function buildTeamsMessage(i: CardInput): Record<string, unknown> {
  const facts = [
    { title: '프로젝트', value: clip(i.projectName, 200) },
    { title: '대상', value: clip(i.target, 300) },
    { title: '환경', value: clip(i.environment, 100) },
    { title: '상태', value: statusLabel(i.status, i.flaky, i.skipReason) },
    ...(i.failedStep ? [{ title: '실패 단계', value: clip(i.failedStep, 300) }] : []),
    { title: '소요 시간', value: formatDuration(i.durationMs) },
    ...(i.scheduleName ? [{ title: '예약', value: clip(i.scheduleName, 100) }] : []),
    ...(i.attempt > 1 ? [{ title: '시도', value: `재실행 (${i.attempt}회차)` }] : []),
  ];
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: clip(`[euta] ${TITLE[i.kind]} — ${i.target}`, 300),
              weight: 'Bolder',
              size: 'Medium',
              wrap: true,
              color: i.kind === 'failure' || i.kind === 'aborted' ? 'Attention' : i.kind === 'recovery' || i.kind === 'passed' ? 'Good' : 'Warning',
            },
            { type: 'FactSet', facts },
          ],
          actions: [{ type: 'Action.OpenUrl', title: '실행 보기', url: i.url }],
        },
      },
    ],
  };
}

export async function enqueueNotification(
  tx: DbOrTx,
  n: { projectId: string; runId: string; kind: NotificationKind; payload: Record<string, unknown>; at: Date },
): Promise<void> {
  await tx.insert(notifications).values({ projectId: n.projectId, runId: n.runId, kind: n.kind, payload: n.payload, nextAttemptAt: n.at, createdAt: n.at });
}

/** `Retry-After` seconds or HTTP date → ms (null when absent/invalid). */
function retryAfterMs(v: string | null, now: number): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
};

/** An error text that might quote the webhook URL (e.g. a fetch failure): URL → host, any `sig=` value masked. */
export function scrubWebhook(text: string, url: string): string {
  return text.split(url).join(hostOf(url)).replace(/([?&]sig=)[^&\s"']*/gi, '$1***');
}

/**
 * Send due notifications (one row per transaction, row-locked while posting). 2xx → sent;
 * 408/429/5xx/network → retry with backoff (honouring Retry-After); other 4xx → failed.
 */
export async function sendPendingNotifications(ctx: AppContext, max = 50): Promise<{ sent: number; failed: number; retried: number; deferred: number }> {
  const out = { sent: 0, failed: 0, retried: 0, deferred: 0 };
  const doFetch = ctx.fetch;
  for (let i = 0; i < max; i++) {
    const handled = await ctx.db.transaction(async (tx) => {
      const now = ctx.clock.now();
      const [n] = await tx
        .select()
        .from(notifications)
        .where(and(eq(notifications.status, 'pending'), lte(notifications.nextAttemptAt, now)))
        .orderBy(asc(notifications.nextAttemptAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!n) return false;
      const [p] = await tx.select({ url: projects.teamsWebhookUrl }).from(projects).where(eq(projects.id, n.projectId));
      if (!p?.url) {
        await tx.update(notifications).set({ status: 'failed', lastError: 'no Teams webhook URL configured' }).where(eq(notifications.id, n.id));
        out.failed++;
        return true;
      }
      const [recent] = await tx
        .select({ c: count() })
        .from(notifications)
        .where(and(eq(notifications.projectId, n.projectId), eq(notifications.status, 'sent'), gte(notifications.sentAt, new Date(now.getTime() - FIVE_MIN))));
      if (Number(recent?.c ?? 0) >= NOTIFY_MAX_PER_5MIN) {
        await tx.update(notifications).set({ nextAttemptAt: new Date(now.getTime() + 60_000) }).where(eq(notifications.id, n.id));
        out.deferred++;
        return true;
      }
      const attempts = n.attempts + 1;
      let status: number | null = null;
      let error: string | null = null;
      let retryAfter: number | null = null;
      try {
        const res = await doFetch(p.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(n.payload),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        status = res.status;
        retryAfter = retryAfterMs(res.headers.get('retry-after'), now.getTime());
      } catch (e) {
        error = (e as Error).name === 'TimeoutError' ? 'timeout' : scrubWebhook(`network error: ${(e as Error).message}`, p.url).slice(0, 300);
      }
      if (status !== null && status >= 200 && status < 300) {
        await tx.update(notifications).set({ status: 'sent', attempts, lastStatusCode: status, lastError: null, sentAt: now }).where(eq(notifications.id, n.id));
        out.sent++;
        return true;
      }
      const retryable = status === null || status === 408 || status === 429 || status >= 500;
      if (status !== null) error = `HTTP ${status}`;
      if (retryable && attempts < NOTIFY_MAX_ATTEMPTS) {
        const delay = Math.min(Math.max(NOTIFY_BACKOFF_MS[attempts - 1]!, retryAfter ?? 0), 60 * 60_000);
        await tx
          .update(notifications)
          .set({ attempts, lastStatusCode: status, lastError: error, nextAttemptAt: new Date(now.getTime() + delay) })
          .where(eq(notifications.id, n.id));
        out.retried++;
      } else {
        await tx.update(notifications).set({ status: 'failed', attempts, lastStatusCode: status, lastError: error }).where(eq(notifications.id, n.id));
        out.failed++;
      }
      ctx.log.warn({ notificationId: n.id, host: hostOf(p.url), attempts, error }, 'teams notification not delivered');
      return true;
    });
    if (!handled) break;
  }
  return out;
}
