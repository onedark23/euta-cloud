// Schedules (SPEC_클라우드-실행-예약 "예약"): cadence presets → 5-field cron in Asia/Seoul, request
// schemas and the list DTO. Cron evaluation (next run, minimum interval) lives in the server.
import * as z from 'zod';
import { RUN_MAX_TIME_LIMIT_SEC, RUN_MIN_TIME_LIMIT_SEC } from './validation.js';

/** Every schedule runs in this time zone (no DST since 1988 — UTC+9 all year). */
export const SCHEDULE_TIMEZONE = 'Asia/Seoul';
/** Two occurrences of one schedule must be at least this far apart. */
export const SCHEDULE_MIN_INTERVAL_MIN = 10;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:MM (00:00–23:59)');

/** Presets (매시간 · 매일 · 평일 · 매주) or a raw 5-field cron expression. */
export const cadenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hourly'), minute: z.number().int().min(0).max(59) }),
  z.object({ kind: z.literal('daily'), time: hhmm }),
  z.object({ kind: z.literal('weekdays'), time: hhmm }),
  /** dayOfWeek: 0 = Sunday … 6 = Saturday (cron convention). */
  z.object({ kind: z.literal('weekly'), dayOfWeek: z.number().int().min(0).max(6), time: hhmm }),
  z.object({ kind: z.literal('cron'), expression: z.string().trim().min(9).max(120) }),
]);
export type Cadence = z.output<typeof cadenceSchema>;

/** Cadence → 5-field cron (`minute hour day-of-month month day-of-week`). */
export function cadenceToCron(c: Cadence): string {
  const at = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return `${m} ${h}`;
  };
  switch (c.kind) {
    case 'hourly':
      return `${c.minute} * * * *`;
    case 'daily':
      return `${at(c.time)} * * *`;
    case 'weekdays':
      return `${at(c.time)} * * 1-5`;
    case 'weekly':
      return `${at(c.time)} * * ${c.dayOfWeek}`;
    case 'cron':
      return c.expression.trim().split(/\s+/).join(' ');
  }
}

const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'name contains control characters');

const scheduleFields = {
  name,
  scriptId: z.string().min(1).optional(),
  suiteId: z.string().min(1).optional(),
  /** Defaults to the suite's default environment, then the project's default environment (stored at save). */
  environmentId: z.string().min(1).optional(),
  cadence: cadenceSchema,
  /** null → the project's run time limit at fire time. */
  timeLimitSec: z.number().int().min(RUN_MIN_TIME_LIMIT_SEC).max(RUN_MAX_TIME_LIMIT_SEC).nullable().optional(),
  /** 실패 시 재실행: off (default) or once. */
  retryOnFailure: z.boolean().optional(),
  enabled: z.boolean().optional(),
};

export const scheduleCreateSchema = z.object(scheduleFields).refine((b) => [b.scriptId, b.suiteId].filter((v) => v !== undefined).length === 1, {
  message: 'give exactly one of scriptId, suiteId',
  path: ['target'],
});

export const scheduleUpdateSchema = z
  .object(scheduleFields)
  .partial()
  .refine((b) => !(b.scriptId !== undefined && b.suiteId !== undefined), { message: 'give at most one of scriptId, suiteId', path: ['target'] });

/** Why an occurrence was recorded as `skipped` instead of running. */
export const RUN_SKIP_REASONS = ['overlap', 'missed', 'daily-cap'] as const;
export type RunSkipReason = (typeof RUN_SKIP_REASONS)[number];

export interface ScheduleDto {
  id: string;
  name: string;
  target: { kind: 'script'; script: { id: string | null; path: string | null; name: string | null } } | { kind: 'suite'; suite: { id: string | null; name: string | null } };
  environment: { id: string | null; name: string | null };
  cadence: Cadence;
  cron: string;
  timezone: string;
  timeLimitSec: number | null;
  retryOnFailure: boolean;
  enabled: boolean;
  /** Set when the server turned the schedule off (e.g. `project_trashed`). */
  disabledReason: string | null;
  /** Next occurrence (null while disabled). */
  nextRunAt: string | null;
  /** Shortest gap between occurrences (minutes). */
  intervalMin: number;
  createdBy: { id: string | null; label: string };
  createdAt: string;
  updatedAt: string;
  lastRun: { id: string; status: string; flaky: boolean; skipReason: string | null; finishedAt: string | null } | null;
  /** The average of the last 3 run durations is longer than the interval (SPEC: 경고). */
  durationWarning: { avgDurationMs: number; intervalMs: number } | null;
}
