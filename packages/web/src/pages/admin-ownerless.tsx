// 관리자 > 소유자 없는 프로젝트 (stage 15, SPEC "관리자 소유자 지정"): projects whose owners are all
// deactivated. The admin picks a new owner by name — existing members first, or anyone in the org by
// search. No other project access for admins (names and people only).
import type { OwnerlessProjectDto, UserSummaryDto } from '@euta-cloud/shared';
import { Crown, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { ROLE_KO } from '../format';
import { Badge, Button, EmptyState, TextField, Tooltip } from '../ui';

function AssignOwner({ project, onDone }: { project: OwnerlessProjectDto; onDone: () => Promise<void> }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<UserSummaryDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!q.trim()) return setFound([]);
    let stale = false;
    const t = setTimeout(() => {
      api<{ users: UserSummaryDto[] }>('GET', `/api/users?q=${encodeURIComponent(q.trim())}`)
        .then((r) => !stale && setFound(r.users))
        .catch(() => !stale && setFound([]));
    }, 200);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q]);
  const assign = async (u: { id: string; name: string }) => {
    if (!window.confirm(`${u.name} 님을 "${project.name}" 의 소유자로 지정할까요?`)) return;
    setError(null);
    try {
      await api('POST', `/api/admin/projects/${encodeURIComponent(project.id)}/owner`, { userId: u.id });
      await onDone();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const memberIds = new Set(project.members.map((m) => m.id));
  const candidates: { id: string; name: string; email: string; note?: string }[] = [
    ...project.members.map((m) => ({ id: m.id, name: m.name, email: m.email, note: ROLE_KO[m.role] })),
    ...found.filter((u) => !memberIds.has(u.id)),
  ];
  return (
    <div className="stack">
      <TextField label="새 소유자 찾기 (이름 또는 이메일)" name="owner-search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {candidates.length === 0 ? (
        <p className="muted small">구성원이 없습니다 — 이름으로 조직 구성원을 찾으세요.</p>
      ) : (
        <ul className="plain pick-list">
          {candidates.map((u) => (
            <li key={u.id} className="row between" data-testid="owner-candidate" data-email={u.email}>
              <span>
                <strong>{u.name}</strong> <span className="muted small">{u.email}</span> {u.note && <Badge>{u.note}</Badge>}
              </span>
              <Tooltip label="이 사람을 이 프로젝트의 소유자로 지정합니다">
                <Button size="sm" icon={Crown} onClick={() => void assign(u)} data-testid="owner-assign">
                  소유자로 지정
                </Button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function OwnerlessProjects() {
  const [list, setList] = useState<OwnerlessProjectDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setList((await api<{ projects: OwnerlessProjectDto[] }>('GET', '/api/admin/projects/ownerless')).projects);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section data-testid="ownerless">
      <h2>소유자 없는 프로젝트 {list ? `(${list.length})` : ''}</h2>
      <p className="muted small">소유자가 모두 비활성화된 프로젝트입니다. 새 소유자를 지정하면 그 사람이 구성원·공개 범위를 관리합니다. 관리자는 프로젝트 내용을 볼 수 없습니다.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {list === null ? (
        <p className="muted">불러오는 중…</p>
      ) : list.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="소유자 없는 프로젝트가 없습니다." />
      ) : (
        list.map((p) => (
          <div key={p.id} className="boxed" data-testid="ownerless-row" data-project-id={p.id}>
            <h3>
              {p.name} <Badge>{p.visibility === 'members' ? '구성원만' : '조직 공개'}</Badge>
            </h3>
            <p className="muted small">
              비활성 소유자: {p.owners.map((o) => `${o.name} (${o.email})`).join(', ') || '없음'} · 만든 날 {new Date(p.createdAt).toLocaleDateString('ko-KR')}
            </p>
            <AssignOwner project={p} onDone={load} />
          </div>
        ))
      )}
    </section>
  );
}
