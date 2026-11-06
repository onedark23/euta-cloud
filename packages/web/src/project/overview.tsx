// 현황: 최근 실행 · 예약(다음 실행) · 최근 실패 · 오늘 실행 수/하루 상한 · 테스트 규칙.
import type { RunDto, ScheduleDto } from '@euta-cloud/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api';
import { cadenceText, fmtTime, isFailureClass, StatusBadge } from '../format';
import { Link } from '../router';
import { useProject, useProjectEvents } from './context';
import { RunTable, RunTarget } from './runs';
import { projectHref } from './shell';
import { Clock } from 'lucide-react';
import { Badge, Card, EmptyState } from '../ui';

export function OverviewTab() {
  const { project, environments, reload } = useProject();
  const pid = project.id;
  const [runs, setRuns] = useState<RunDto[] | null>(null);
  const [schedules, setSchedules] = useState<ScheduleDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        api<{ runs: RunDto[] }>('GET', `/api/projects/${encodeURIComponent(pid)}/runs?limit=50`),
        api<{ schedules: ScheduleDto[] }>('GET', `/api/projects/${encodeURIComponent(pid)}/schedules`),
      ]);
      setRuns(r.runs);
      setSchedules(s.schedules);
    } catch (e) {
      setError(errorText(e));
    }
  }, [pid]);
  useEffect(() => {
    void load();
  }, [load]);
  useProjectEvents((e) => {
    if (e.kind !== 'resync' && !/^(run\.(requested|finished|cancelled|uploaded|skipped)|schedule\.)/.test(e.kind)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void load();
      void reload();
    }, 300);
  });

  const usage = project.dailyRunUsage;
  const failures = (runs ?? []).filter((r) => isFailureClass(r.status)).slice(0, 5);
  const upcoming = (schedules ?? []).filter((s) => s.enabled && s.nextRunAt).sort((a, b) => a.nextRunAt!.localeCompare(b.nextRunAt!));
  return (
    <div className="overview" data-testid="overview">
      {error && <p className="error">{error}</p>}
      <div className="stats">
        <Card as="div" className="stat" data-testid="daily-cap">
          <div className="muted small">오늘 실행 (Asia/Seoul)</div>
          <b>
            {usage ? `${usage.used} / ${usage.cap}` : `- / ${project.dailyRunCap}`}
          </b>
          {usage && usage.used >= usage.cap && <div className="error small">하루 실행 상한에 도달 — 예약 회차는 건너뜁니다</div>}
        </Card>
        <Card as="div" className="stat">
          <div className="muted small">환경</div>
          <b>{environments.length}</b>
          {environments.some((e) => !e.cloudRunnable) && <div className="warn small">클라우드 실행 불가 주소 있음</div>}
        </Card>
        <Card as="div" className="stat">
          <div className="muted small">켜진 예약</div>
          <b>{schedules ? schedules.filter((s) => s.enabled).length : '-'}</b>
        </Card>
      </div>
      {project.testRules && (
        <Card as="div" className="rules" data-testid="test-rules">
          <b>테스트 규칙</b>
          <p className="pre">{project.testRules}</p>
        </Card>
      )}

      <div className="overview-grid">
        <Card>
          <h3>최근 실패</h3>
          {failures.length === 0 ? (
            <p className="muted">최근 실패가 없습니다.</p>
          ) : (
            <ul className="plain" data-testid="recent-failures">
              {failures.map((r) => (
                <li key={r.id}>
                  <StatusBadge status={r.status} /> <Link href={projectHref(pid, `/runs/${encodeURIComponent(r.id)}`)}>
                    <RunTarget run={r} />
                  </Link> <span className="muted small">· {r.environment.name} · {fmtTime(r.finishedAt ?? r.queuedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <h3>예약</h3>
          {upcoming.length === 0 ? (
            <p className="muted">켜진 예약이 없습니다.</p>
          ) : (
            <ul className="plain" data-testid="upcoming-schedules">
              {upcoming.slice(0, 5).map((s) => (
                <li key={s.id}>
                  <b>{s.name}</b> <span className="muted small">· {cadenceText(s.cadence)} · 다음 {fmtTime(s.nextRunAt)}</span>
                  {s.durationWarning && <Badge tone="warn">소요 시간이 주기보다 김</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card>
        <h3>최근 실행</h3>
        {runs === null ? (
          <p className="muted">불러오는 중…</p>
        ) : runs.length === 0 ? (
          <EmptyState icon={Clock} title="아직 실행 기록이 없습니다." />
        ) : (
          <RunTable runs={runs.slice(0, 10)} pid={pid} />
        )}
        <p>
          <Link href={projectHref(pid, '/runs')}>실행 이력 전체 →</Link>
        </p>
      </Card>
    </div>
  );
}
