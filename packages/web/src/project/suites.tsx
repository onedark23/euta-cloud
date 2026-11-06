// 테스트 세트 (SPEC 테스트 세트, 내부 이름 suite): 이름 · 스크립트 목록(순서, 스크립트 id 로 — 이름 변경을
// 따라감) · 항목별 "항상 실행"(취소해도 실행 — 정리 스크립트, ADR-031) · 기본 환경.
// 만들기/고치기/삭제는 편집자 이상, 실행은 실행 권한.
import type { ScriptDto } from '@euta-cloud/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { useProject, useProjectEvents } from './context';
import { RunPanel } from './run-panel';
import { ScriptName, ScriptPicker } from './script-name';
import { ArrowDown, ArrowUp, ListChecks, Minus, Pencil, Play, Plus, Save, Trash, X } from 'lucide-react';
import { Badge, Button, Card, Checkbox, EmptyState, IconButton, TextField, Select } from '../ui';

export interface SuiteDto {
  id: string;
  name: string;
  scripts: { id: string; path: string | null }[];
  /** "항상 실행" script ids. */
  alwaysRun: string[];
  defaultEnvironmentId: string | null;
  updatedAt: string;
}

interface Draft {
  id?: string;
  name: string;
  scriptIds: string[];
  alwaysRun: string[];
  defaultEnvironmentId: string;
}

export function SuitesTab() {
  const { project, environments, can } = useProject();
  const pid = project.id;
  const editable = can('suite.edit');
  const [list, setList] = useState<SuiteDto[] | null>(null);
  const [scripts, setScripts] = useState<ScriptDto[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  /** Scripts checked in the picker, in check order — added in that order. */
  const [toAdd, setToAdd] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, sc] = await Promise.all([
        api<{ suites: SuiteDto[] }>('GET', `/api/projects/${encodeURIComponent(pid)}/suites`),
        api<{ scripts: ScriptDto[] }>('GET', `/api/projects/${encodeURIComponent(pid)}/scripts`),
      ]);
      setList(s.suites);
      setScripts(sc.scripts);
    } catch (e) {
      setError(errorText(e));
    }
  }, [pid]);
  useEffect(() => {
    void load();
  }, [load]);
  useProjectEvents((e) => {
    if (e.kind === 'resync' || e.kind.startsWith('suite.') || e.kind.startsWith('script.')) void load();
  });

  const scriptLabel = (id: string, path?: string | null) => {
    const s = scripts.find((x) => x.id === id);
    if (!s && !path) return <span className="muted">(삭제된 스크립트)</span>;
    return <ScriptName name={s?.name} path={s?.path ?? path!} />;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const body = { name: draft.name.trim(), scriptIds: draft.scriptIds, alwaysRun: draft.alwaysRun.filter((id) => draft.scriptIds.includes(id)), defaultEnvironmentId: draft.defaultEnvironmentId || null };
    try {
      if (draft.id) await api('PATCH', `/api/projects/${encodeURIComponent(pid)}/suites/${encodeURIComponent(draft.id)}`, body);
      else await api('POST', `/api/projects/${encodeURIComponent(pid)}/suites`, body);
      setDraft(null);
      setToAdd([]);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const remove = async (s: SuiteDto) => {
    if (!window.confirm(`테스트 세트 "${s.name}" 을(를) 삭제할까요? 스크립트는 지우지 않습니다.`)) return;
    try {
      await api('DELETE', `/api/projects/${encodeURIComponent(pid)}/suites/${encodeURIComponent(s.id)}`);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const move = (i: number, d: number) =>
    setDraft((x) => {
      if (!x) return x;
      const ids = [...x.scriptIds];
      const j = i + d;
      if (j < 0 || j >= ids.length) return x;
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
      return { ...x, scriptIds: ids };
    });

  return (
    <Card>
      <div className="row between toolbar">
        <p className="muted small">테스트 세트는 스크립트를 순서대로 실행합니다(실패해도 다음 스크립트로). “항상 실행” 항목은 테스트 세트를 취소해도 실행합니다(정리 스크립트용).</p>
        {editable && !draft && (
          <Button variant="primary" icon={Plus} onClick={() => setDraft({ name: '', scriptIds: [], alwaysRun: [], defaultEnvironmentId: '' })} data-testid="new-suite">
            새 테스트 세트
          </Button>
        )}
      </div>
      {draft && (
        <form className="boxed" onSubmit={submit} data-testid="suite-form">
          <div className="inline">
            <TextField label="이름" className="grow" name="suite-name" required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <Select label="기본 환경" value={draft.defaultEnvironmentId} onChange={(e) => setDraft({ ...draft, defaultEnvironmentId: e.target.value })}>
              <option value="">(프로젝트 기본)</option>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </div>
          <ol className="suite-scripts">
            {draft.scriptIds.map((id, i) => (
              <li key={`${id}-${i}`} data-testid="suite-form-item">
                <span className="suite-order">{i + 1}</span>
                <span className="grow-text">{scriptLabel(id)}</span>
                <Checkbox
                  label="항상 실행"
                  className="small"
                  checked={draft.alwaysRun.includes(id)}
                  onChange={(e) => setDraft({ ...draft, alwaysRun: e.target.checked ? [...draft.alwaysRun, id] : draft.alwaysRun.filter((x) => x !== id) })}
                  data-testid="suite-always"
                />
                <IconButton icon={ArrowUp} label="위로" onClick={() => move(i, -1)} disabled={i === 0} />
                <IconButton icon={ArrowDown} label="아래로" onClick={() => move(i, 1)} disabled={i === draft.scriptIds.length - 1} />
                <Button size="sm" variant="danger" icon={Minus} onClick={() => setDraft({ ...draft, scriptIds: draft.scriptIds.filter((_x, j) => j !== i) })}>
                  빼기
                </Button>
              </li>
            ))}
          </ol>
          <ScriptPicker
            scripts={scripts}
            picked={toAdd}
            onChange={setToAdd}
            label="넣을 스크립트 찾기 (이름 또는 경로)"
            testId="suite-pick"
            footer={
              <div className="row">
                <Button
                  icon={Plus}
                  disabled={!toAdd.length}
                  onClick={() => {
                    setDraft({ ...draft, scriptIds: [...draft.scriptIds, ...toAdd] });
                    setToAdd([]);
                  }}
                  data-testid="suite-pick-add"
                  title="체크한 스크립트를 체크한 순서대로 위 목록 끝에 넣습니다"
                >
                  {toAdd.length ? `체크한 ${toAdd.length}개 넣기` : '넣을 스크립트를 체크하세요'}
                </Button>
              </div>
            }
          />
          <div className="row">
            <Button type="submit" variant="primary" icon={draft.id ? Save : Plus} disabled={!draft.name.trim()}>
              {draft.id ? '저장' : '만들기'}
            </Button>
            <Button
              icon={X}
              onClick={() => {
                setDraft(null);
                setToAdd([]);
              }}
            >
              취소
            </Button>
          </div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      {list === null ? (
        <p className="muted">불러오는 중…</p>
      ) : list.length === 0 ? (
        <EmptyState icon={ListChecks} title="테스트 세트가 없습니다." />
      ) : (
        <div className="suite-list">
          {list.map((s) => (
            <div key={s.id} className="boxed" data-testid="suite-row" data-name={s.name}>
              <div className="row between">
                <b>{s.name}</b>
                <div className="row">
                  {can('run.execute') && (
                    <Button size="sm" icon={Play} onClick={() => setRunning(running === s.id ? null : s.id)} active={running === s.id}>
                      실행…
                    </Button>
                  )}
                  {editable && (
                    <>
                      <Button
                        size="sm"
                        icon={Pencil}
                        onClick={() => setDraft({ id: s.id, name: s.name, scriptIds: s.scripts.map((x) => x.id), alwaysRun: s.alwaysRun ?? [], defaultEnvironmentId: s.defaultEnvironmentId ?? '' })}
                      >
                        고치기
                      </Button>
                      <Button size="sm" variant="danger" icon={Trash} onClick={() => void remove(s)}>
                        삭제
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <ol className="small suite-items">
                {s.scripts.map((x, i) => (
                  <li key={`${x.id}-${i}`} data-testid="suite-item">
                    {scriptLabel(x.id, x.path)}
                    {s.alwaysRun?.includes(x.id) && <Badge data-testid="suite-item-always">항상 실행</Badge>}
                  </li>
                ))}
              </ol>
              <div className="muted small">기본 환경: {environments.find((e) => e.id === s.defaultEnvironmentId)?.name ?? '(프로젝트 기본)'}</div>
              {running === s.id && <RunPanel target={{ suiteId: s.id }} defaultEnvId={s.defaultEnvironmentId} />}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
