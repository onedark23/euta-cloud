// 실행 이력 (SPEC 실행 화면): 상태 · 대상 · 환경 · 출처 · 요청자 · 시작 · 소요 시간 · 실행 위치. 필터 + 더 보기.
import { RUN_SOURCES, RUN_STATUSES, type RunDto } from '@euta-cloud/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText } from '../api';
import { fmtDuration, fmtTime, RUN_STATUS_KO, SOURCE_KO, StatusBadge } from '../format';
import { Link, navigate, useLocation } from '../router';
import { useProject, useProjectEvents } from './context';
import { ScriptName } from './script-name';
import { projectHref } from './shell';
import { ChevronDown, Clock, Search } from 'lucide-react';
import { Badge, Button, Card, EmptyState } from '../ui';

/** What a run ran: the test set name, or the script's name (of the version it pinned) with its path small. */
export function RunTarget({ run, stacked = false }: { run: RunDto; stacked?: boolean }) {
  if (run.kind === 'suite') return <span>테스트 세트 {run.suite?.name ?? ''}</span>;
  if (!run.script) return <span>-</span>;
  return <ScriptName name={run.script.name} path={run.script.path} stacked={stacked} />;
}

export function RunTable({ runs, pid }: { runs: RunDto[]; pid: string }) {
  return (
    <div className="table-wrap">
    <table data-testid="run-table">
      <thead>
        <tr>
          <th>상태</th>
          <th>대상</th>
          <th>환경</th>
          <th>출처</th>
          <th>요청자</th>
          <th>시작</th>
          <th>소요</th>
          <th>실행 위치</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} data-testid="run-row" data-run-id={r.id} data-status={r.status}>
            <td>
              <Link href={projectHref(pid, `/runs/${encodeURIComponent(r.id)}`)}>
                <StatusBadge status={r.status} flaky={r.flaky} skipReason={r.skipReason} />
              </Link>
            </td>
            <td>
              <Link href={projectHref(pid, `/runs/${encodeURIComponent(r.id)}`)}>
                <RunTarget run={r} stacked />
              </Link>
              {r.attempt > 1 && <Badge>재실행</Badge>}
              {r.alwaysRun && (
                <Badge data-testid="run-always" title="테스트 세트를 취소해도 실행합니다">
                  항상 실행
                </Badge>
              )}
            </td>
            <td>{r.environment.name}</td>
            <td data-testid="run-source">{SOURCE_KO[r.source] ?? r.source}</td>
            <td className="small">{r.requestedBy.label}</td>
            <td className="small">{fmtTime(r.startedAt ?? r.queuedAt)}</td>
            <td className="small">{fmtDuration(r.durationMs)}</td>
            <td className="small" data-testid="run-location">
              {r.runnerLocation ?? '-'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

export function RunsTab() {
  const { project, environments } = useProject();
  const loc = useLocation();
  const status = loc.query.get('status') ?? '';
  const source = loc.query.get('source') ?? '';
  const env = loc.query.get('env') ?? '';
  const target = loc.query.get('target') ?? '';
  const [runs, setRuns] = useState<RunDto[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetText, setTargetText] = useState(target);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useCallback(
    (before?: string) => {
      const q = new URLSearchParams();
      if (status) q.set('status', status);
      if (source) q.set('source', source);
      if (env) q.set('env', env);
      if (target) q.set('target', target);
      if (before) q.set('before', before);
      q.set('limit', '50');
      return `/api/projects/${encodeURIComponent(project.id)}/runs?${q}`;
    },
    [project.id, status, source, env, target],
  );

  const load = useCallback(async () => {
    try {
      const r = (await api<{ runs: RunDto[] }>('GET', query())).runs;
      setRuns(r);
      setMore(r.length === 50);
    } catch (e) {
      setError(errorText(e));
    }
  }, [query]);
  useEffect(() => {
    void load();
  }, [load]);
  useProjectEvents((e) => {
    if (e.kind !== 'resync' && !/^run\.(requested|started|finished|cancelled|uploaded|skipped)/.test(e.kind)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 300);
  });

  const loadMore = async () => {
    if (!runs?.length) return;
    const r = (await api<{ runs: RunDto[] }>('GET', query(runs[runs.length - 1]!.id))).runs;
    setRuns([...runs, ...r]);
    setMore(r.length === 50);
  };

  const setFilter = (k: string, v: string) => {
    const q = new URLSearchParams(loc.query);
    if (v) q.set(k, v);
    else q.delete(k);
    const s = q.toString();
    navigate(projectHref(project.id, `/runs${s ? `?${s}` : ''}`), { replace: true });
  };

  return (
    <Card>
      <div className="row filters" data-testid="run-filters">
        <select value={status} onChange={(e) => setFilter('status', e.target.value)} aria-label="상태">
          <option value="">상태: 전체</option>
          {RUN_STATUSES.map((s) => (
            <option key={s} value={s}>
              {RUN_STATUS_KO[s]}
            </option>
          ))}
        </select>
        <select value={source} onChange={(e) => setFilter('source', e.target.value)} aria-label="출처">
          <option value="">출처: 전체</option>
          {RUN_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_KO[s]}
            </option>
          ))}
        </select>
        <select value={env} onChange={(e) => setFilter('env', e.target.value)} aria-label="환경">
          <option value="">환경: 전체</option>
          {environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter('target', targetText.trim());
          }}
        >
          <input placeholder="대상 (스크립트 경로)" value={targetText} onChange={(e) => setTargetText(e.target.value)} />
          <Button type="submit" icon={Search}>
            찾기
          </Button>
        </form>
      </div>
      {error && <p className="error">{error}</p>}
      {runs === null ? <p className="muted">불러오는 중…</p> : runs.length === 0 ? <EmptyState icon={Clock} title="실행 기록이 없습니다." /> : <RunTable runs={runs} pid={project.id} />}
      {more && (
        <div className="more">
          <Button icon={ChevronDown} onClick={() => void loadMore()}>
            더 보기
          </Button>
        </div>
      )}
    </Card>
  );
}
