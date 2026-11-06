// Badge: dot + text, pill. Tones follow SPEC "상태 매핑" (ok · bad · run · warn · idle = grey · manual =
// "수동 확인 필요"); `neutral` is a grey tag without the dot (e.g. "기본", "현재").
import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export type BadgeTone = 'ok' | 'bad' | 'warn' | 'run' | 'idle' | 'manual' | 'neutral';

const RUN_TONE: Record<string, BadgeTone> = {
  passed: 'ok',
  failed: 'bad',
  error: 'bad',
  timeout: 'bad',
  aborted: 'bad',
  queued: 'run',
  leased: 'run',
  running: 'run',
  cancelled: 'idle',
  skipped: 'idle',
};

/** Run status → badge tone (flaky passes are `warn`). */
export const runTone = (status: string, flaky?: boolean): BadgeTone => (flaky && status === 'passed' ? 'warn' : (RUN_TONE[status] ?? 'idle'));

export function Badge({ tone = 'neutral', className, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cx('badge', `badge-${tone}`, className)} {...rest} />;
}
