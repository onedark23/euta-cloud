// 작업 로그 (SPEC 작업 로그): 시간 역순 · 종류(접두어)·행위자 필터 · 더 보기 · 항목 → 대상.
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { fmtTime } from '../format';
import { Link, navigate, useLocation } from '../router';
import { useProject, useProjectEvents } from './context';
import { scriptHref } from './scripts';
import { projectHref } from './shell';
import { ChevronDown, ScrollText } from 'lucide-react';
import { Button, Card, EmptyState } from '../ui';

interface Entry {
  id: number;
  at: string;
  actor: { type: string; id: string | null; label: string };
  kind: string;
  target: { type: string; id: string | null } | null;
  summary: string;
  details: Record<string, unknown>;
}

const KINDS: [string, string][] = [
  ['', '종류: 전체'],
  ['project', '프로젝트'],
  ['member', '구성원'],
  ['environment', '환경'],
  ['credential', '테스트 계정'],
  ['script', '스크립트'],
  ['suite', '테스트 세트'],
  ['schedule', '예약'],
  ['run', '실행'],
];
const ACTORS: [string, string][] = [
  ['', '행위자: 전체'],
  ['user', '구성원'],
  ['ai', 'AI (MCP)'],
  ['schedule', '예약'],
  ['system', '시스템'],
];

export function ActivityTab() {
  const { project } = useProject();
  const pid = project.id;
  const loc = useLocation();
  const kind = loc.query.get('kind') ?? '';
  const actor = loc.query.get('actor') ?? '';
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const url = useCallback(
    (before?: number) => {
      const q = new URLSearchParams();
      if (kind) q.set('kind', kind);
      if (actor) q.set('actor', actor);
      if (before) q.set('before', String(before));
      return `/api/projects/${encodeURIComponent(pid)}/activity?${q}`;
    },
    [pid, kind, actor],
  );
  const load = useCallback(async () => {
    try {
      const r = await api<{ entries: Entry[]; nextBefore: number | null }>('GET', url());
      setEntries(r.entries);
      setNext(r.nextBefore);
    } catch (e) {
      setError(errorText(e));
    }
  }, [url]);
  useEffect(() => {
    void load();
  }, [load]);
  useProjectEvents((e) => {
    if (e.kind === 'resync' || !/^run\.(progress|leased|started)$/.test(e.kind)) void load();
  });

  const more = async () => {
    if (!next) return;
    const r = await api<{ entries: Entry[]; nextBefore: number | null }>('GET', url(next));
    setEntries([...(entries ?? []), ...r.entries]);
    setNext(r.nextBefore);
  };

  const setFilter = (k: string, v: string) => {
    const q = new URLSearchParams(loc.query);
    if (v) q.set(k, v);
    else q.delete(k);
    const s = q.toString();
    navigate(projectHref(pid, `/activity${s ? `?${s}` : ''}`), { replace: true });
  };

  const targetLink = (e: Entry) => {
    const d = e.details ?? {};
    if (e.target?.type === 'run' && e.target.id) return projectHref(pid, `/runs/${encodeURIComponent(e.target.id)}`);
    if (e.kind.startsWith('run.') && typeof d.runId === 'string') return projectHref(pid, `/runs/${encodeURIComponent(d.runId)}`);
    if (e.target?.type === 'script' && e.kind !== 'script.deleted') {
      const p = typeof d.to === 'string' ? d.to : typeof d.path === 'string' ? d.path : null;
      return p ? scriptHref(pid, p) : projectHref(pid, '/scripts');
    }
    if (e.target?.type === 'schedule') return projectHref(pid, '/schedules');
    if (e.target?.type === 'suite') return projectHref(pid, '/suites');
    if (e.target?.type === 'environment' || e.target?.type === 'member' || e.kind.startsWith('project.')) return projectHref(pid, '/settings');
    return null;
  };

  return (
    <Card>
      <div className="row filters">
        <select value={kind} onChange={(e) => setFilter('kind', e.target.value)} aria-label="종류" data-testid="activity-kind">
          {KINDS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select value={actor} onChange={(e) => setFilter('actor', e.target.value)} aria-label="행위자" data-testid="activity-actor">
          {ACTORS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {entries === null ? (
        <p className="muted">불러오는 중…</p>
      ) : entries.length === 0 ? (
        <EmptyState icon={ScrollText} title="기록이 없습니다." />
      ) : (
        <table data-testid="activity-table">
          <tbody>
            {entries.map((e) => {
              const href = targetLink(e);
              return (
                <tr key={e.id} data-testid="activity-row" data-kind={e.kind}>
                  <td className="small muted nowrap">{fmtTime(e.at)}</td>
                  <td className="small">{e.actor.label}</td>
                  <td>{href ? <Link href={href}>{e.summary}</Link> : e.summary}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {next && (
        <div className="more">
          <Button icon={ChevronDown} onClick={() => void more()}>
            더 보기
          </Button>
        </div>
      )}
    </Card>
  );
}
