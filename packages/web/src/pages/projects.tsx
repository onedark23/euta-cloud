// 프로젝트 목록 (SPEC 계정 "웹 화면"): 내 프로젝트 / 전체, 최근 실행 상태, 새 프로젝트, 휴지통(소유자 복원).
import { TRASH_RETENTION_DAYS, type ProjectDto } from '@euta-cloud/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { fmtTime, ROLE_KO, StatusBadge } from '../format';
import { projectHref } from '../project/shell';
import { Link, navigate, useLocation } from '../router';
import { ArchiveRestore, FolderKanban, FolderPlus, Plus, Trash } from 'lucide-react';
import { Badge, Button, Card, EmptyState, PageHeader, Tabs, TextField } from '../ui';

type Scope = 'mine' | 'all' | 'trash';

export function ProjectsPage() {
  const loc = useLocation();
  const scope: Scope = (['mine', 'all', 'trash'] as const).find((s) => s === loc.query.get('scope')) ?? 'mine';
  const [list, setList] = useState<ProjectDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setList(null);
    try {
      const q = scope === 'trash' ? 'trashed=1' : `scope=${scope}`;
      setList((await api<{ projects: ProjectDto[] }>('GET', `/api/projects?${q}`)).projects);
    } catch (e) {
      setError(errorText(e));
    }
  }, [scope]);
  useEffect(() => {
    void load();
  }, [load]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<ProjectDto>('POST', '/api/projects', { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
      navigate(projectHref(p.id, '/settings'));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (p: ProjectDto) => {
    try {
      await api('POST', `/api/projects/${encodeURIComponent(p.id)}/restore`);
      navigate(projectHref(p.id));
    } catch (e) {
      setError(errorText(e));
    }
  };

  const daysLeft = (iso: string) => Math.max(0, TRASH_RETENTION_DAYS - Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));

  return (
    <Card>
      <PageHeader
        title="프로젝트"
        actions={
          scope !== 'trash' && (
            <Button variant="primary" icon={Plus} onClick={() => setCreating((c) => !c)} data-testid="new-project" active={creating}>
              새 프로젝트
            </Button>
          )
        }
      />
      <Tabs
        items={[
          { key: 'mine', label: '내 프로젝트', href: '/?scope=mine' },
          { key: 'all', label: '전체', href: '/?scope=all' },
          { key: 'trash', label: '휴지통', href: '/?scope=trash' },
        ]}
        active={scope}
      />

      {creating && (
        <form className="inline boxed" onSubmit={create} data-testid="new-project-form">
          <TextField label="이름" name="project-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <TextField label="설명 (선택)" className="grow" name="project-description" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
          <Button type="submit" icon={FolderPlus} disabled={busy || !name.trim()}>
            만들기
          </Button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {list === null ? (
        <p className="muted">불러오는 중…</p>
      ) : list.length === 0 ? (
        <EmptyState
          icon={scope === 'trash' ? Trash : FolderKanban}
          title={scope === 'trash' ? '휴지통이 비어 있습니다. (내가 소유자인 프로젝트만 보입니다)' : scope === 'mine' ? '초대받은 프로젝트가 없습니다. "전체" 에서 조직의 모든 프로젝트를 볼 수 있습니다.' : '프로젝트가 없습니다.'}
        />
      ) : scope === 'trash' ? (
        <table>
          <thead>
            <tr>
              <th>이름</th>
              <th>삭제한 날</th>
              <th>남은 기간</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id} data-testid="trash-row">
                <td>{p.name}</td>
                <td>{fmtTime(p.deletedAt)}</td>
                <td>{p.deletedAt ? `${daysLeft(p.deletedAt)}일` : '-'}</td>
                <td>
                  <Button size="sm" icon={ArchiveRestore} onClick={() => void restore(p)}>
                    복원
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table>
          <thead>
            <tr>
              <th>이름</th>
              <th>내 역할</th>
              <th>최근 실행</th>
              <th>설명</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id} data-testid="project-row">
                <td>
                  <Link href={projectHref(p.id)} className="strong-link">
                    {p.name}
                  </Link>
                  {p.visibility === 'members' && <Badge data-testid="project-members-only">구성원만</Badge>}
                </td>
                <td>{ROLE_KO[p.myRole] ?? p.myRole}</td>
                <td>
                  {p.lastRun ? (
                    <Link href={projectHref(p.id, `/runs/${encodeURIComponent(p.lastRun.id)}`)}>
                      <StatusBadge status={p.lastRun.status} flaky={p.lastRun.flaky} /> <span className="muted small">{fmtTime(p.lastRun.finishedAt ?? p.lastRun.queuedAt)}</span>
                    </Link>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </td>
                <td className="muted small">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
