// Cron evaluation for schedules (ADR-020 §3): 5-field cron in Asia/Seoul via cron-parser 5.x.
// Validation rejects anything beyond plain 5-field cron (seconds field, H jitter, L/W/#/?), and
// computes the shortest gap between occurrences exactly from the parsed fields.
import { SCHEDULE_MIN_INTERVAL_MIN, SCHEDULE_TIMEZONE } from '@euta-cloud/shared';
import { CronExpressionParser } from 'cron-parser';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const NUMERIC = /^[0-9*,/-]+$/;
const DAY_MIN = 24 * 60;
/** Day-gap search horizon: 4 years + 1 day covers Feb 29 and every month/weekday combination. */
const DAY_SCAN = 4 * 366 + 1;

export class CronError extends Error {}

function checkField(value: string, aliases: string[] | null, label: string): void {
  if (NUMERIC.test(value)) return;
  if (aliases) {
    const words = value.match(/[A-Za-z]+/g) ?? [];
    const rest = value.replace(/[A-Za-z]+/g, '0');
    if (NUMERIC.test(rest) && words.every((w) => aliases.includes(w.toUpperCase()))) return;
  }
  throw new CronError(`invalid ${label} field "${value}" — use numbers, *, ranges (a-b), lists (a,b) and steps (/n)`);
}

function parse(cron: string, currentDate?: Date) {
  return CronExpressionParser.parse(cron, { tz: SCHEDULE_TIMEZONE, ...(currentDate ? { currentDate } : {}) });
}

/** Minutes-of-day an expression fires at, sorted. */
function timesOfDay(fields: { minute: { values: readonly number[] }; hour: { values: readonly number[] } }): number[] {
  const out: number[] = [];
  for (const h of fields.hour.values) for (const m of fields.minute.values) out.push(h * 60 + m);
  return [...new Set(out)].sort((a, b) => a - b);
}

/** Smallest number of days between two consecutive days the expression fires on (null = never fires). */
function minDayGap(dom: string, month: string, dow: string): number | null {
  const it = parse(`0 0 ${dom} ${month} ${dow}`, new Date(Date.UTC(2024, 0, 1, -9) - 1000));
  let prev: number | null = null;
  let best: number | null = null;
  for (let i = 0; i < DAY_SCAN; i++) {
    let d: Date;
    try {
      d = it.next().toDate();
    } catch {
      break;
    }
    const day = Math.round(d.getTime() / 86_400_000);
    if (prev !== null) {
      const gap = day - prev;
      if (best === null || gap < best) best = gap;
      if (best === 1) break;
    }
    prev = day;
    if (d.getTime() > Date.UTC(2028, 0, 2)) break;
  }
  return best ?? (prev !== null ? 366 * 4 : null);
}

/**
 * Validate a 5-field cron expression and return its shortest interval in minutes.
 * Throws CronError (message safe to show) when invalid, never firing, or closer than the minimum.
 */
export function analyzeCron(cron: string): { intervalMin: number } {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError('cron must have exactly 5 fields: minute hour day-of-month month day-of-week');
  const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
  checkField(min, null, 'minute');
  checkField(hour, null, 'hour');
  checkField(dom, null, 'day-of-month');
  checkField(month, MONTHS, 'month');
  checkField(dow, DAYS, 'day-of-week');
  let expr;
  try {
    expr = parse(parts.join(' '));
  } catch (e) {
    throw new CronError(`invalid cron expression: ${(e as Error).message}`);
  }
  const times = timesOfDay(expr.fields);
  const dayGap = minDayGap(dom, month, dow);
  if (!times.length || dayGap === null) throw new CronError('this cron expression never runs');
  let interval = times[0]! + dayGap * DAY_MIN - times[times.length - 1]!;
  for (let i = 1; i < times.length; i++) interval = Math.min(interval, times[i]! - times[i - 1]!);
  if (interval < SCHEDULE_MIN_INTERVAL_MIN) {
    throw new CronError(`runs must be at least ${SCHEDULE_MIN_INTERVAL_MIN} minutes apart (this expression has a ${interval}-minute gap)`);
  }
  return { intervalMin: interval };
}

/** Last occurrence strictly before `before` (Asia/Seoul). */
export function prevOccurrence(cron: string, before: Date): Date {
  return parse(cron, before).prev().toDate();
}

/** First occurrence strictly after `after` (Asia/Seoul). */
export function nextOccurrence(cron: string, after: Date): Date {
  return parse(cron, after).next().toDate();
}
