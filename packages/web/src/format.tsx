// Shared labels and formatting for the project / run screens (Korean UI).
import type { Cadence, RunSource, RunStatus } from '@euta-cloud/shared';
import { Badge, runTone } from './ui';

export const RUN_STATUS_KO: Record<string, string> = {
  queued: '대기',
  leased: '시작 중',
  running: '실행 중',
  passed: '통과',
  failed: '실패',
  error: '오류',
  timeout: '시간 초과',
  aborted: '중단',
  cancelled: '취소',
  skipped: '건너뜀',
};

export const SOURCE_KO: Record<RunSource, string> = { web: '웹', app: '앱', ai_mcp: 'AI', schedule: '예약', local_upload: '로컬 올림' };
export const SKIP_REASON_KO: Record<string, string> = { overlap: '겹침', missed: '놓침', 'daily-cap': '하루 상한' };
export const ROLE_KO: Record<string, string> = { owner: '소유자', editor: '편집자', runner: '실행자', viewer: '보기' };
export const ORIGIN_KO: Record<string, string> = { web: '웹', app: '앱', ai_mcp: 'AI', external: '앱 바깥 변경', revert: '되돌리기' };

export const isActiveRun = (s: string) => s === 'queued' || s === 'leased' || s === 'running';
export const isFailureClass = (s: string) => s === 'failed' || s === 'error' || s === 'timeout';

export function StatusBadge({ status, flaky, skipReason }: { status: RunStatus | string; flaky?: boolean; skipReason?: string | null }) {
  return (
    <Badge tone={runTone(status, flaky)} data-testid="run-status" data-status={status}>
      {RUN_STATUS_KO[status] ?? status}
      {flaky ? ' · 불안정' : ''}
      {skipReason ? ` (${SKIP_REASON_KO[skipReason] ?? skipReason})` : ''}
    </Badge>
  );
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}초`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return `${m}분 ${rest}초`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('ko-KR') : '-');

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** "매일 09:00" · "평일 18:30" · "매주 월 09:00" · "매시간 15분" · "cron: …". */
export function cadenceText(c: Cadence): string {
  switch (c.kind) {
    case 'hourly':
      return `매시간 ${c.minute}분`;
    case 'daily':
      return `매일 ${c.time}`;
    case 'weekdays':
      return `평일 ${c.time}`;
    case 'weekly':
      return `매주 ${DAYS[c.dayOfWeek] ?? c.dayOfWeek} ${c.time}`;
    case 'cron':
      return `cron: ${c.expression}`;
  }
}

/** `KEY=value` lines → object (blank lines and `#` comments skipped); returns the bad lines too. */
export function parseKeyValues(text: string): { values: Record<string, string>; bad: string[] } {
  const values: Record<string, string> = {};
  const bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) bad.push(line);
    else values[m[1]!] = m[2]!.trim();
  }
  return { values, bad };
}

export const keyValuesText = (o: Record<string, string | number | boolean>) =>
  Object.entries(o)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
