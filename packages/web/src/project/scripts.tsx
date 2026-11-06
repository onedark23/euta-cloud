// 스크립트 탭: 목록(이름 굵게 + 경로 작게) · 새 스크립트(이름 → 경로 자동 제안 → 폼 편집기로) · 삭제된 스크립트(복원).
import { scriptPathError, TRASH_RETENTION_DAYS, type ScriptDto } from '@euta-cloud/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { fmtTime } from '../format';
import { encodePath, navigate } from '../router';
import { useProject, useProjectEvents } from './context';
import { ScriptName, suggestScriptPath } from './script-name';
import { projectHref } from './shell';
import { ArchiveRestore, FilePlus, FileText, Plus, Search } from 'lucide-react';
import { Badge, Button, Card, Checkbox, EmptyState, TextField } from '../ui';

export const scriptHref = (pid: string, path: string, query = '') => projectHref(pid, `/scripts/${encodePath(path)}${query}`);

export function ScriptsTab() {
  const { project, readOnly } = useProject();
  const [deleted, setDeleted] = useState(false);
  const [list, setList] = useState<ScriptDto[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  /** The path field follows the name until the person edits it. */
  const [pathEdited, setPathEdited] = useState(false);

  const load = useCallback(async () => {
    try {
      setList((await api<{ scripts: ScriptDto[] }>('GET', `/api/projects/${encodeURIComponent(project.id)}/scripts${deleted ? '?deleted=1' : ''}`)).scripts);
    } catch (e) {
      setError(errorText(e));
    }
  }, [project.id, deleted]);
  useEffect(() => {
    void load();
  }, [load]);
  useProjectEvents((e) => {
    if (e.kind === 'resync' || e.kind.startsWith('script.')) void load();
  });

  const fullPath = (p: string) => {
    const t = p.trim();
    return t && !/\.ya?ml$/i.test(t) ? `${t}.yaml` : t;
  };
  const taken = new Set((list ?? []).map((s) => s.path));
  const onName = (v: string) => {
    setNewName(v);
    if (!pathEdited) setNewPath(v.trim() ? suggestScriptPath(v, taken) : '');
  };
  const pathErr = newPath.trim() ? (scriptPathError(fullPath(newPath)) ?? (taken.has(fullPath(newPath)) ? '이미 있는 경로입니다' : null)) : null;
  const create = (e: FormEvent) => {
    e.preventDefault();
    const p = fullPath(newPath);
    if (!newName.trim() || !p || pathErr) return;
    navigate(scriptHref(project.id, p, `?new=1&name=${encodeURIComponent(newName.trim())}`));
  };

  const restore = async (s: ScriptDto) => {
    try {
      await api('POST', `/api/projects/${encodeURIComponent(project.id)}/scripts/${encodePath(s.path)}/restore`);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const q = filter.trim().toLowerCase();
  const shown = (list ?? []).filter((s) => !q || s.path.toLowerCase().includes(q) || (s.name ?? '').toLowerCase().includes(q));
  return (
    <Card>
      <div className="row between toolbar">
        <div className="row">
          <label className="search">
            <Search size={14} aria-hidden="true" />
            <input placeholder="이름·경로로 찾기" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          <Checkbox label="삭제된 스크립트" checked={deleted} onChange={(e) => setDeleted(e.target.checked)} data-testid="show-deleted" />
        </div>
        {!readOnly && !deleted && (
          <Button variant="primary" icon={Plus} onClick={() => setCreating((c) => !c)} data-testid="new-script" active={creating}>
            새 스크립트
          </Button>
        )}
      </div>
      {creating && (
        <form className="inline boxed" onSubmit={create} data-testid="new-script-form">
          <TextField label="이름" help="예: 로그인 후 보고서 내보내기" className="grow" name="script-name" required maxLength={200} value={newName} onChange={(e) => onName(e.target.value)} autoFocus />
          <TextField
            label="경로"
            help="이름에서 자동으로 정합니다. 고칠 수 있습니다 (예: checkout/pay.yaml)"
            error={pathErr}
            className="grow"
            name="script-path"
            value={newPath}
            onChange={(e) => {
              setNewPath(e.target.value);
              setPathEdited(true);
            }}
          />
          <Button type="submit" icon={FilePlus} disabled={!newName.trim() || !newPath.trim() || !!pathErr}>
            폼 편집기로 만들기
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
      ) : shown.length === 0 ? (
        <EmptyState icon={FileText} title={deleted ? '삭제된 스크립트가 없습니다.' : '스크립트가 없습니다.'} />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>스크립트</th>
                <th>버전</th>
                <th>검증</th>
                <th>{deleted ? '삭제한 때' : '마지막 저장'}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <tr key={s.id} data-testid="script-row" data-path={s.path}>
                  <td>
                    <ScriptName name={s.name} path={s.path} href={deleted ? undefined : scriptHref(project.id, s.path)} stacked />
                  </td>
                  <td>v{s.version}</td>
                  <td>{s.validationOk ? <Badge tone="ok">통과</Badge> : <Badge tone="warn">검증 오류</Badge>}</td>
                  <td className="small">
                    {deleted ? (
                      <>
                        {fmtTime(s.deletedAt)} <span className="muted">({TRASH_RETENTION_DAYS}일 뒤 영구 삭제)</span>
                      </>
                    ) : (
                      <>
                        {fmtTime(s.updatedAt)} <span className="muted">{s.updatedBy?.name ?? ''}</span>
                      </>
                    )}
                  </td>
                  <td className="actions">
                    {deleted && !readOnly && (
                      <Button size="sm" icon={ArchiveRestore} onClick={() => void restore(s)}>
                        복원
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
