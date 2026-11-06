// Script detail (SPEC 스크립트-보기-편집, the local app's behavior on the web — no AI request button):
// Korean step sentences (`@euta/core/describe`), the latest cloud run overlaid only when it ran exactly
// this content (hash), warnings (validation · missing credential · secrets placement · OS input · CSS),
// form editing with live validation (`POST …/scripts/check`), save only when valid with the base
// version → conflict dialog (3 choices like the app), history/compare/revert, rename/delete.
// Logic follows euta-app src/renderer/src/tabs/ScriptDetail.tsx (see ADR-029).
import type { RunDetailDto, RunDto, ScriptCheckDto, ScriptDto, ScriptVersionDto, ValidationIssueDto } from '@euta-cloud/shared';
import { scriptPathError } from '@euta-cloud/shared';
import { describeStep } from '@euta/core/describe';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api, ApiError, errorText } from '../api';
import { fmtDuration, fmtTime, ORIGIN_KO, StatusBadge } from '../format';
import { encodePath, Link, navigate, setLeaveGuard, useLocation } from '../router';
import { diffScripts, type ScriptDiff } from '../script/diff';
import { friendly, issueWhere, koSecretRule } from '../script/messages';
import {
  addStep,
  deleteStep,
  duplicateStep,
  flatten,
  fromModel,
  getStep,
  groupIn,
  groupOut,
  issueStepPath,
  moveDown,
  moveStep,
  moveUp,
  NEW_STEP_KINDS,
  plainStep,
  setHeader,
  setStep,
  stepIdOf,
  toModel,
  toPayload,
  type EModel,
  type StepPath,
} from '../script/model';
import { HeaderForm, StepForm, type FormContext } from '../script/StepForm';
import { feedData, useProject, useProjectEvents } from './context';
import { fileUrl, loadRunJsonSteps, type StepFile } from './run-files';
import { RunPanel } from './run-panel';
import { scriptHref } from './scripts';
import { projectHref } from './shell';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  FileClock,
  FolderInput,
  FolderOutput,
  GripVertical,
  Image,
  Pencil,
  Play,
  RotateCcw,
  Save,
  TextCursorInput,
  Trash,
  X,
} from 'lucide-react';
import { Badge, Button, Card, Dialog, DialogActions, IconButton, StepIcon, TextField } from '../ui';

type Mode = 'view' | 'edit' | 'history';
type ScriptWithSource = ScriptDto & { source: string; validation: { ok: boolean; issues: ValidationIssueDto[] } };
interface Overlay {
  run: RunDto;
  steps: Record<string, StepFile>;
  hashMatch: boolean;
}

const STATUS_ICON: Record<string, string> = { passed: '✔', failed: '✖', error: '✖', skipped: '–' };
const samePath = (a: StepPath | undefined, b: StepPath) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
const sameParent = (a: StepPath, b: StepPath) => a.length === b.length && a.slice(0, -1).every((x, i) => x === b[i]);

/** New script text; `name` = what the person typed on the scripts tab (else the file name). */
export const templateFor = (path: string, name?: string | null) => {
  const base = name?.trim() || path.split('/').pop()!.replace(/\.ya?ml$/i, '');
  return `version: 1\nname: ${JSON.stringify(base)}\ntarget:\n  baseUrl: \${env.BASE_URL}\nsteps:\n  - goto: /\n`;
};

/** `<dir>/<name>-<my name>.yaml`, `-2`, `-3` … when taken (app SPEC 충돌 ③). */
export function copyPathFor(path: string, myName: string, taken: Set<string>): string {
  const m = /^(.*?)(\.ya?ml)$/i.exec(path);
  const stem = m ? m[1]! : path;
  const ext = m ? m[2]! : '.yaml';
  const who = myName.trim().replace(/[\\/:*?"<>|\s.]+/g, '-').replace(/^-+|-+$/g, '') || 'copy';
  let p = `${stem}-${who}${ext}`;
  for (let n = 2; taken.has(p); n++) p = `${stem}-${who}-${n}${ext}`;
  return p;
}

function checkSource(pid: string, body: Record<string, unknown>) {
  return api<ScriptCheckDto>('POST', `/api/projects/${encodeURIComponent(pid)}/scripts/check`, body);
}

export function ScriptDetail({ path }: { path: string }) {
  const { project, environments, me, readOnly, can } = useProject();
  const pid = project.id;
  const loc = useLocation();
  const isNew = loc.query.get('new') === '1';
  const apiBase = `/api/projects/${encodeURIComponent(pid)}/scripts/${encodePath(path)}`;
  const [script, setScript] = useState<ScriptWithSource | null | undefined>(undefined);
  const [viewCheck, setViewCheck] = useState<ScriptCheckDto | null>(null);
  const [envId, setEnvId] = useState<string>(project.defaultEnvironmentId ?? environments[0]?.id ?? '');
  const [mode, setMode] = useState<Mode>('view');
  const [model, setModel] = useState<EModel | undefined>();
  const [base, setBase] = useState<string>('');
  /** The version the edit started from (the save's base version — a newer server version → 409). */
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [rev, setRev] = useState(0);
  const [check, setCheck] = useState<{ rev: number; r: ScriptCheckDto } | undefined>();
  const [openId, setOpenId] = useState<string | undefined>();
  const [headerOpen, setHeaderOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [shot, setShot] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState<StepPath | undefined>();
  const [remote, setRemote] = useState<{ version?: number; by?: string } | null>(null);
  const [conflict, setConflict] = useState<ConflictView | null>(null);
  const [showRun, setShowRun] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const ref = useRef({ mode, dirty, script });
  ref.current = { mode, dirty, script };

  const load = useCallback(async (): Promise<ScriptWithSource | null> => {
    try {
      const s = await api<ScriptWithSource>('GET', apiBase);
      setScript(s);
      setError(null);
      return s;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setScript(null);
        return null;
      }
      setError(errorText(e));
      return null;
    }
  }, [apiBase]);

  const loadOverlay = useCallback(
    async (s: ScriptWithSource | null) => {
      if (!s) return setOverlay(null);
      try {
        const runs = (await api<{ runs: RunDto[] }>('GET', `/api/projects/${encodeURIComponent(pid)}/runs?target=${encodeURIComponent(s.id)}&limit=1`)).runs;
        const r = runs[0];
        if (!r) return setOverlay(null);
        const d = await api<RunDetailDto>('GET', `/api/projects/${encodeURIComponent(pid)}/runs/${encodeURIComponent(r.id)}`);
        const steps: Record<string, StepFile> = {};
        for (const st of d.steps) steps[st.stepId] = { stepId: st.stepId, status: st.status, durationMs: st.durationMs, ...(st.error ? { error: st.error } : {}), ...(st.manual ? { manual: st.manual } : {}) };
        if (d.resultFiles === 'present') {
          const files = await loadRunJsonSteps(pid, d.id);
          for (const [id, f] of Object.entries(files)) steps[id] = { ...steps[id], ...f };
        }
        setOverlay({ run: d, steps, hashMatch: d.script?.contentHash === s.contentHash });
      } catch {
        setOverlay(null);
      }
    },
    [pid],
  );

  const startEdit = useCallback(
    async (text: string, version: number | null) => {
      try {
        const c = await checkSource(pid, { source: text, ...(envId ? { environmentId: envId } : {}) });
        if (!c.script) {
          setError('YAML 을 읽을 수 없어 폼으로 고칠 수 없습니다 — 로컬 앱에서 고치세요.');
          return;
        }
        setModel(toModel(c.script));
        setBase(text);
        setBaseVersion(version);
        setCheck(undefined);
        setOpenId(undefined);
        setRemote(null);
        setRev((r) => r + 1);
        setMode('edit');
      } catch (e) {
        setError(errorText(e));
      }
    },
    [pid, envId],
  );

  // First load: an existing script → view; `?new=1` on a free path → editor with a template.
  useEffect(() => {
    void (async () => {
      const s = await load();
      if (s) void loadOverlay(s);
      else if (isNew && !readOnly) {
        await startEdit(templateFor(path, loc.query.get('name')), null);
        setDirty(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // View-mode check of the saved text (step sentences need the parsed script; warnings per environment).
  useEffect(() => {
    if (!script) return setViewCheck(null);
    let stale = false;
    checkSource(pid, { source: script.source, ...(envId ? { environmentId: envId } : {}) })
      .then((c) => !stale && setViewCheck(c))
      .catch((e) => !stale && setError(errorText(e)));
    return () => {
      stale = true;
    };
  }, [pid, script, envId]);

  // Live validation of the edit (debounced; the serialized result is what gets checked and saved).
  useEffect(() => {
    if (mode !== 'edit' || !model) return;
    const at = rev;
    const t = setTimeout(() => {
      checkSource(pid, { base, edit: toPayload(model), ...(envId ? { environmentId: envId } : {}) })
        .then((r) => setCheck((c) => (c && c.rev > at ? c : { rev: at, r })))
        .catch((e) => setError(errorText(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [mode, model, base, rev, pid, envId]);

  // Unsaved edit: ask before leaving (in-app navigation and tab close).
  useEffect(() => {
    if (!(mode === 'edit' && dirty)) return;
    const remove = setLeaveGuard(() => window.confirm('저장하지 않은 변경이 있습니다. 버리고 나갈까요?'));
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      remove();
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [mode, dirty]);

  // Other people's saves / renames / deletes of this script, and runs finishing (overlay).
  useProjectEvents((e) => {
    const s = ref.current.script;
    if (e.kind === 'resync') {
      if (ref.current.mode !== 'edit') void load().then((x) => void loadOverlay(x));
      return;
    }
    const d = feedData(e);
    if (e.kind.startsWith('run.') && e.kind !== 'run.leased') {
      if (s && (e.kind !== 'run.progress' || d.runId === overlay?.run.id)) void loadOverlay(s);
      return;
    }
    if (!s || d.targetId !== s.id) return;
    if (e.kind === 'script.renamed' && typeof d.to === 'string') {
      if (ref.current.mode === 'edit' && ref.current.dirty) setRemote({ by: '이름 변경됨' });
      else navigate(scriptHref(pid, d.to), { replace: true, force: true });
      return;
    }
    if (e.kind === 'script.deleted') {
      setNote('이 스크립트가 삭제됐습니다.');
      return;
    }
    if (e.kind === 'script.saved' || e.kind === 'script.reverted' || e.kind === 'script.restored') {
      if (e.actorId === me.id && ref.current.mode !== 'edit') return;
      const version = typeof d.version === 'number' ? d.version : undefined;
      if (ref.current.mode === 'edit' && ref.current.dirty) {
        setRemote({ ...(version !== undefined ? { version } : {}) });
        void load();
      } else if (ref.current.mode === 'edit') {
        void load().then((x) => x && void startEdit(x.source, x.version));
      } else {
        void load().then((x) => {
          void loadOverlay(x);
          if (e.actorId !== me.id) setNote(`다른 사람이 저장했습니다${version ? ` (버전 ${version})` : ''} — 최신 내용으로 바꿨습니다.`);
        });
      }
    }
  });

  const update = (fn: (m: EModel) => EModel) => {
    setModel((m) => (m ? fn(m) : m));
    setDirty(true);
    setRev((r) => r + 1);
  };

  const viewModel = useMemo(() => (viewCheck?.script ? toModel(viewCheck.script) : undefined), [viewCheck]);
  const shown = mode === 'edit' ? model : viewModel;
  const envOf = environments.find((e) => e.id === envId);
  const ctx: FormContext = useMemo(() => {
    const vars = shown?.header.vars;
    return { secretNames: envOf?.credentialNames ?? [], varNames: vars && typeof vars === 'object' ? Object.keys(vars) : [] };
  }, [envOf?.credentialNames, shown?.header]);

  const cur = mode === 'edit' ? check?.r : viewCheck;
  const issues = (cur?.validation.issues ?? []).map((i) => ({ ...i, message: friendly(i.message) }));
  const missing = cur?.missingSecrets ?? [];
  const ruleIssues = cur?.ruleIssues ?? [];
  const osIssues = cur?.osInputIssues ?? [];
  const unstable = cur?.unstable ?? 0;
  const checking = mode === 'edit' && (!check || check.rev !== rev);
  const canSave = mode === 'edit' && dirty && !checking && !!check?.r.validation.ok && !saving;
  const stale = !!overlay && !overlay.hashMatch;

  const flat = useMemo(() => {
    if (!shown) return [];
    return flatten(shown).filter((f) => !f.path.slice(0, -1).some((_x, i) => collapsed.has(stepIdOf(f.path.slice(0, i + 1)))));
  }, [shown, collapsed]);

  const finishSave = async (msg: string) => {
    setDirty(false);
    setMode('view');
    setConflict(null);
    setRemote(null);
    setNote(msg);
    if (isNew) navigate(scriptHref(pid, path), { replace: true, force: true });
    const s = await load();
    void loadOverlay(s);
  };

  const put = (p: string, source: string, baseVersion: number | null) =>
    api<{ script: ScriptDto; version: ScriptVersionDto | null; unchanged: boolean }>('PUT', `/api/projects/${encodeURIComponent(pid)}/scripts/${encodePath(p)}`, { source, baseVersion, origin: 'web' });

  const save = async () => {
    if (!check || !canSave) return;
    setSaving(true);
    setError(null);
    const mine = check.r;
    try {
      const r = await put(path, mine.source, baseVersion);
      await finishSave(r.unchanged ? '바뀐 내용이 없어 새 버전을 만들지 않았습니다.' : `저장했습니다 — 버전 ${r.script.version}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SCRIPT_CONFLICT') {
        const current = ((e.details as { current?: ScriptVersionDto | null } | undefined)?.current ?? null) as ScriptVersionDto | null;
        const [serverScript, all] = await Promise.all([
          current?.source ? checkSource(pid, { source: current.source }).then((c) => c.script) : Promise.resolve(null),
          api<{ scripts: ScriptDto[] }>('GET', `/api/projects/${encodeURIComponent(pid)}/scripts`),
        ]);
        const copyPath = copyPathFor(path, me.name, new Set(all.scripts.map((s) => s.path)));
        setConflict({ mine: mine.source, mineScript: mine.script ?? (model ? fromModel(model) : {}), current, serverScript, copyPath });
      } else if (e instanceof ApiError && (e.code === 'SCRIPT_INVALID' || e.code === 'YAML_PARSE_ERROR')) {
        setError(`검증 오류로 저장하지 않았습니다: ${((e.details as { issues?: ValidationIssueDto[] })?.issues ?? []).map((i) => friendly(i.message)).join(' / ')}`);
      } else setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const resolve = async (choice: 'mine' | 'theirs' | 'copy') => {
    if (!conflict) return;
    setError(null);
    try {
      if (choice === 'mine') {
        const r = await put(path, conflict.mine, conflict.current?.version ?? null);
        await finishSave(`내 것으로 새 버전을 저장했습니다 — 버전 ${r.script.version}`);
      } else if (choice === 'theirs') {
        setDirty(false);
        setConflict(null);
        setMode('view');
        setRemote(null);
        const s = await load();
        void loadOverlay(s);
        setNote('서버 최신 내용을 받았습니다 (내 변경은 버림).');
      } else {
        const copy = conflict.copyPath;
        await put(copy, conflict.mine, null);
        setDirty(false);
        setConflict(null);
        navigate(scriptHref(pid, copy), { force: true });
      }
    } catch (e) {
      setError(errorText(e));
    }
  };

  const rename = async () => {
    if (!renaming) return;
    const to = renaming.trim();
    const err = scriptPathError(to);
    if (err) return setError(err);
    try {
      await api('POST', `${apiBase}/rename`, { newPath: to });
      setRenaming(null);
      navigate(scriptHref(pid, to), { replace: true, force: true });
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'NAME_TAKEN' ? `이미 있는 경로입니다: ${to}` : errorText(e));
    }
  };

  const remove = async () => {
    if (!window.confirm(`스크립트 "${path}" 를 삭제할까요? 30일 안에는 "삭제된 스크립트" 에서 복원할 수 있습니다.`)) return;
    try {
      await api('DELETE', apiBase);
      navigate(projectHref(pid, '/scripts'), { force: true });
    } catch (e) {
      setError(errorText(e));
    }
  };

  const addMenu = (testId: string, at: StepPath, label = '+ 아래에 단계 추가') => (
    <select
      className="add-step"
      value=""
      onChange={(e) => {
        const k = NEW_STEP_KINDS.find((x) => x.kind === e.target.value);
        if (!k || !model) return;
        const next = addStep(model, at, k.make());
        update(() => next);
        setOpenId(getStep(next, at)?.id);
      }}
      data-testid={testId}
    >
      <option value="">{label}</option>
      {NEW_STEP_KINDS.map((k) => (
        <option key={k.kind} value={k.kind}>
          {k.label}
        </option>
      ))}
    </select>
  );

  const onDrop = (e: DragEvent, to: StepPath) => {
    e.preventDefault();
    if (drag && sameParent(drag, to)) update((m) => moveStep(m, drag, to[to.length - 1]!));
    setDrag(undefined);
  };

  if (script === undefined && !error) return <p className="muted">불러오는 중…</p>;
  if (script === null && mode !== 'edit') {
    return (
      <Card>
        <p>스크립트를 찾을 수 없습니다: <code>{path}</code></p>
        <Link href={projectHref(pid, '/scripts')}>스크립트 목록</Link>
      </Card>
    );
  }

  const title = (mode === 'edit' ? String(model?.header.name ?? '') : String(viewCheck?.script?.name ?? '')) || path;
  return (
    <Card as="div" className="script-detail" data-testid="script-detail" data-path={path} data-mode={mode}>
      <div className="row between">
        <Link href={projectHref(pid, '/scripts')} className="back-link">
          <ArrowLeft size={14} aria-hidden="true" />
          스크립트 목록
        </Link>
        <code className="muted" data-testid="script-path">
          {path}
          {script ? ` · v${script.version}` : ' · 새 스크립트'}
        </code>
      </div>
      <h2 data-testid="detail-name">{title}</h2>
      {typeof shown?.header.description === 'string' && shown.header.description && <p className="muted">{shown.header.description}</p>}

      <div className="row small" data-testid="detail-last-run">
        {overlay ? (
          <>
            최근 실행: <StatusBadge status={overlay.run.status} flaky={overlay.run.flaky} /> · {overlay.run.environment.name} · {fmtTime(overlay.run.startedAt ?? overlay.run.queuedAt)}
            {stale && (
              <Badge tone="warn" data-testid="overlay-stale">
                수정 이후 아직 실행하지 않음
              </Badge>
            )}
            <Link href={projectHref(pid, `/runs/${encodeURIComponent(overlay.run.id)}`)} data-testid="detail-run-link">
              실행 상세
            </Link>
          </>
        ) : (
          <span className="muted">{script ? '아직 클라우드 실행 기록이 없습니다.' : ''}</span>
        )}
      </div>

      {mode !== 'edit' ? (
        <div className="row toolbar">
          <label className="inline-label">
            환경
            <select value={envId} onChange={(e) => setEnvId(e.target.value)} data-testid="detail-env" title="경고(테스트 계정 확인)에 쓸 환경">
              {environments.length === 0 && <option value="">(환경 없음)</option>}
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          {can('run.execute') && script && (
            <Button variant="primary" icon={Play} onClick={() => setShowRun((v) => !v)} data-testid="detail-run">
              실행…
            </Button>
          )}
          {!readOnly && script && (
            <>
              <Button icon={Pencil} onClick={() => void startEdit(script.source, script.version).then(() => setDirty(false))} data-testid="detail-edit">
                편집
              </Button>
            </>
          )}
          {script && (
            <Button icon={FileClock} active={mode === 'history'} onClick={() => setMode(mode === 'history' ? 'view' : 'history')} data-testid="detail-history">
              이력
            </Button>
          )}
          {!readOnly && script && (
            <>
              <Button icon={TextCursorInput} active={renaming !== null} onClick={() => setRenaming(renaming === null ? path : null)} data-testid="detail-rename">
                이름 변경
              </Button>
              <Button variant="danger" icon={Trash} onClick={() => void remove()} data-testid="detail-delete">
                삭제
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className="row toolbar">
          <Button variant="primary" icon={Save} disabled={!canSave} onClick={() => void save()} data-testid="edit-save">
            저장
          </Button>
          <Button
            icon={X}
            onClick={() => {
              if (dirty && !window.confirm('편집한 내용을 버릴까요?')) return;
              setDirty(false);
              setMode('view');
              if (isNew) navigate(projectHref(pid, '/scripts'), { force: true });
            }}
            data-testid="edit-cancel"
          >
            취소
          </Button>
          <span className="small" data-testid="edit-status">
            {!dirty ? <span className="muted">바뀐 것 없음</span> : checking ? <span className="muted">검증 중…</span> : issues.length ? <span className="error">오류 {issues.length}개 — 고쳐야 저장할 수 있습니다</span> : <span className="ok">✓ 저장할 수 있습니다</span>}
          </span>
          <Button variant="ghost" icon={headerOpen ? ChevronDown : ChevronRight} active={headerOpen} onClick={() => setHeaderOpen((o) => !o)} data-testid="edit-header-toggle">
            스크립트 정보 (이름·설명·기본값·녹화·브라우저·변수)
          </Button>
        </div>
      )}

      {renaming !== null && (
        <div className="inline boxed" data-testid="rename-form">
          <TextField label="새 경로" className="grow" value={renaming} onChange={(e) => setRenaming(e.target.value)} />
          <Button icon={Save} onClick={() => void rename()} disabled={!renaming.trim() || renaming.trim() === path}>
            바꾸기
          </Button>
          <Button icon={X} onClick={() => setRenaming(null)}>
            취소
          </Button>
        </div>
      )}

      {showRun && mode === 'view' && script && <RunPanel key={envId} target={{ scriptId: script.id }} defaultEnvId={envId} />}

      {remote && (
        <div className="banner conflict" data-testid="remote-saved">
          다른 사람이 저장함{remote.version !== undefined ? ` (버전 ${remote.version})` : ''}
          {remote.by ? ` · ${remote.by}` : ''} — 편집 중인 내 내용을 저장하면 충돌 화면이 열립니다.{' '}
          <Button size="sm" variant="ghost" icon={X} onClick={() => setRemote(null)}>
            닫기
          </Button>
        </div>
      )}

      {(issues.length > 0 || missing.length > 0 || unstable > 0 || ruleIssues.length > 0 || osIssues.length > 0) && (
        <div className="detail-warnings" data-testid="detail-warnings">
          {issues.length > 0 && (
            <div className="issues bad" data-testid="warn-issues">
              검증 오류 {issues.length}개{mode === 'view' ? ' — 이 버전은 실행할 수 없습니다' : ''}
              <ul>
                {issues.slice(0, 20).map((i, n) => (
                  <li key={n}>
                    {issueWhere(i.path, issueStepPath(i.path))}: {i.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {missing.length > 0 && (
            <div className="issues warn-box" data-testid="warn-missing-secrets">
              환경 {envOf?.name ?? '(없음)'} 에 없는 테스트 계정: {missing.map((m) => `🔒${m}`).join(', ')} — 설정 → 환경에서 등록하세요 (이름만 표시).
            </div>
          )}
          {ruleIssues.length > 0 && (
            <div className="issues bad" data-testid="warn-secret-rule">
              secrets 규칙 위반 {ruleIssues.length}개 — 저장은 되지만 클라우드 실행은 거절됩니다
              <ul>
                {ruleIssues.slice(0, 20).map((i, n) => (
                  <li key={n}>
                    {issueWhere(i.path, issueStepPath(i.path))}: {koSecretRule(i.message)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {osIssues.length > 0 && (
            <div className="issues warn-box" data-testid="warn-os-input">
              OS 입력(input: os) {osIssues.length}곳 — 클라우드에서는 실행할 수 없습니다 (로컬 앱 실행만).
            </div>
          )}
          {unstable > 0 && (
            <div className="issues warn-box" data-testid="warn-unstable">
              ⚠ CSS 로 고른 대상 {unstable}개 — 화면이 바뀌면 깨지기 쉽습니다. 역할·라벨·글자로 바꾸는 것을 권합니다.
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {note && (
        <p className="muted small" data-testid="detail-note" role="status">
          {note}
        </p>
      )}

      {mode === 'edit' && headerOpen && model && (
        <div className="boxed">
          <HeaderForm header={model.header} onChange={(h) => update((m) => setHeader(m, h))} />
        </div>
      )}

      {mode === 'history' && script ? (
        <HistoryView
          pid={pid}
          apiBase={apiBase}
          script={script}
          readOnly={readOnly}
          onReverted={async (v, nv) => {
            setNote(`버전 ${v} 로 되돌렸습니다 — 새 버전 ${nv}`);
            const s = await load();
            void loadOverlay(s);
          }}
        />
      ) : !shown ? (
        viewCheck && !viewCheck.script ? <div className="error">YAML 을 읽을 수 없습니다 — 로컬 앱에서 고치세요.</div> : <p className="muted">불러오는 중…</p>
      ) : (
        <div className={`step-list${stale && mode === 'view' ? ' stale' : ''}`} data-testid="step-list">
          {flat.map(({ path: sp, depth, step }) => {
            const d = describeStep(plainStep(step));
            const sid = stepIdOf(sp);
            const ov = mode === 'view' ? overlay?.steps[sid] : undefined;
            const cardIssues = mode === 'edit' ? issues.filter((i) => samePath(issueStepPath(i.path), sp)) : [];
            const isGroup = !!step.children;
            const isOpen = mode === 'edit' && openId === step.id;
            return (
              <div key={step.id} className="step-wrap" style={{ marginLeft: depth * 24 }}>
                <div
                  className={`step-card${ov ? ` ${ov.status}` : ''}${ov?.manual && !ov.error ? ' manual' : ''}${cardIssues.length ? ' has-issue' : ''}${isOpen ? ' open' : ''}`}
                  data-testid="detail-step"
                  data-step-id={sid}
                  data-status={ov?.status ?? ''}
                  draggable={mode === 'edit'}
                  onDragStart={() => setDrag(sp)}
                  onDragOver={(e) => drag && sameParent(drag, sp) && e.preventDefault()}
                  onDrop={(e) => onDrop(e, sp)}
                >
                  <span className="step-no">{sid}</span>
                  {mode === 'edit' && (
                    <span className="handle" title="끌어서 순서 변경">
                      <GripVertical size={16} aria-hidden="true" />
                    </span>
                  )}
                  <StepIcon action={d.action} />
                  <div className="step-main" onClick={() => mode === 'edit' && setOpenId(isOpen ? undefined : step.id)}>
                    {d.title && (
                      <div className="step-title" data-testid="step-title">
                        {d.title}
                      </div>
                    )}
                    <div className="step-sentence" data-testid="step-sentence">
                      {d.sentence}
                      {isGroup && mode === 'view' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={collapsed.has(sid) ? ChevronRight : ChevronDown}
                          className="inline-btn"
                          onClick={() =>
                            setCollapsed((c) => {
                              const n = new Set(c);
                              if (n.has(sid)) n.delete(sid);
                              else n.add(sid);
                              return n;
                            })
                          }
                        >
                          {collapsed.has(sid) ? '펼치기' : '접기'}
                        </Button>
                      )}
                    </div>
                    {d.details.map((l, i) => (
                      <div key={i} className="step-detail">
                        └ {l}
                      </div>
                    ))}
                    {d.badges.length > 0 && (
                      <div className="step-badges">
                        {d.badges.map((b) => (
                          <Badge key={b}>{b}</Badge>
                        ))}
                      </div>
                    )}
                    {ov?.error && (
                      <div className="step-error" data-testid="step-error">
                        {koSecretRule(ov.error)}
                      </div>
                    )}
                    {cardIssues.map((i, n) => (
                      <div key={n} className="step-error" data-testid="step-issue">
                        {i.path.replace(/^(steps\[\d+\]\.?(group\.)?)+/, '')}: {i.message}
                      </div>
                    ))}
                  </div>
                  {ov && (
                    <div className="step-ov" data-testid="step-overlay" data-status={ov.status}>
                      {ov.manual && !ov.error ? (
                        <Badge tone="manual" data-testid="step-manual">
                          수동 확인 필요
                        </Badge>
                      ) : (
                        <>
                          <span className={`ov-icon ${ov.status}`}>{STATUS_ICON[ov.status] ?? '·'}</span> {fmtDuration(ov.durationMs)}
                        </>
                      )}
                      {ov.screenshot && overlay && (
                        <IconButton icon={Image} label="스크린샷 크게 보기" variant="ghost" onClick={() => setShot(fileUrl(pid, overlay.run.id, ov.screenshot!))} data-testid="step-shot" />
                      )}
                    </div>
                  )}
                  {mode === 'edit' && (
                    <span className="step-tools">
                      <IconButton icon={ArrowUp} label="위로" onClick={() => update((m) => moveUp(m, sp))} disabled={sp[sp.length - 1] === 0} data-testid="step-up" />
                      <IconButton icon={ArrowDown} label="아래로" onClick={() => update((m) => moveDown(m, sp))} data-testid="step-down" />
                      <Button size="sm" icon={Copy} onClick={() => update((m) => duplicateStep(m, sp))} title="복제" data-testid="step-dup">
                        복제
                      </Button>
                      <Button size="sm" icon={FolderInput} onClick={() => update((m) => groupIn(m, sp))} title="위 묶음으로 넣기 (위가 묶음이 아니면 새 묶음)" data-testid="step-group-in">
                        묶음 넣기
                      </Button>
                      {sp.length > 1 && (
                        <Button size="sm" icon={FolderOutput} onClick={() => update((m) => groupOut(m, sp))} title="묶음에서 빼기" data-testid="step-group-out">
                          묶음 빼기
                        </Button>
                      )}
                      <Button size="sm" variant="danger" icon={Trash} onClick={() => update((m) => deleteStep(m, sp))} title="삭제" data-testid="step-del">
                        삭제
                      </Button>
                    </span>
                  )}
                </div>
                {isOpen && model && (
                  <div className="boxed step-form-card">
                    <StepForm step={step.step} onChange={(s) => update((m) => setStep(m, sp, s))} ctx={ctx} />
                  </div>
                )}
                {mode === 'edit' && isGroup && addMenu('step-add-inside', [...sp, step.children!.length], '+ 묶음 안에 추가')}
                {mode === 'edit' && isOpen && addMenu('step-add-below', [...sp.slice(0, -1), sp[sp.length - 1]! + 1])}
              </div>
            );
          })}
          {mode === 'edit' && model && <div className="step-add-end">{addMenu('step-add-end', [model.steps.length], '+ 단계 추가')}</div>}
          {flat.length === 0 && <p className="muted">단계가 없습니다.</p>}
          {mode === 'edit' && model && <p className="muted small">단계를 누르면 폼이 열립니다. ⠿ 를 끌거나 ↑↓ 로 순서를 바꿉니다. 저장하면 바뀐 단계만 다시 쓰고, 나머지 주석·순서는 그대로 둡니다.</p>}
        </div>
      )}

      {conflict && <ConflictDialog view={conflict} path={path} onChoose={(c) => void resolve(c)} onClose={() => setConflict(null)} />}

      {shot && (
        <Dialog label="단계 스크린샷" className="shot-modal" onBackdropClick={() => setShot(undefined)} data-testid="shot-modal">
          <img src={shot} alt="단계 스크린샷" />
        </Dialog>
      )}
    </Card>
  );
}

interface ConflictView {
  mine: string;
  mineScript: Record<string, unknown>;
  /** Server's current version (null = deleted on the server). */
  current: ScriptVersionDto | null;
  serverScript: Record<string, unknown> | null;
  /** Free `<name>-<my name>.yaml` path for choice ③ (computed when the dialog opens). */
  copyPath: string;
}

/** Conflict screen (app SPEC 충돌): server latest ↔ mine as step sentences + 3 choices. */
function ConflictDialog({ view, path, onChoose, onClose }: { view: ConflictView; path: string; onChoose: (c: 'mine' | 'theirs' | 'copy') => void; onClose: () => void }) {
  const diff = diffScripts(view.serverScript ?? undefined, view.mineScript);
  return (
    <Dialog label="충돌" className="conflict-dialog" data-testid="conflict-dialog">
        <h3>충돌 — 서버에 더 새로운 버전이 있습니다</h3>
        <p>
          <code>{path}</code> ·{' '}
          {view.current ? (
            <>
              서버 최신 <b data-testid="conflict-server-version">버전 {view.current.version}</b>
              {view.current.author ? ` · ${view.current.author.name}` : ''} · {fmtTime(view.current.createdAt)}
            </>
          ) : (
            <Badge tone="warn">서버에서 삭제됨</Badge>
          )}
        </p>
        <div className="small muted">
          서버 최신 → 내 것: <span data-testid="conflict-summary">{diff.summary}</span>
          {diff.header.length > 0 && ` · 머리 정보: ${diff.header.join(', ')}`}
        </div>
        <DiffRows diff={diff} labels={{ before: '서버 −', after: '내 것 +', removed: '서버에만 −', added: '내 것에만 +' }} testId="conflict-row" />
        <DialogActions>
          <Button variant="primary" icon={Save} onClick={() => onChoose('mine')} data-testid="conflict-choose-mine">
            ① 내 것으로 새 버전
          </Button>
          <Button icon={RotateCcw} onClick={() => onChoose('theirs')} data-testid="conflict-choose-theirs">
            ② 서버 것 받기 (내 변경 버림)
          </Button>
          <Button icon={Copy} onClick={() => onChoose('copy')} data-testid="conflict-choose-copy">
            ③ 내 것을 사본으로 <code>{view.copyPath}</code>
          </Button>
          <Button variant="ghost" icon={X} onClick={onClose} data-testid="conflict-later">
            닫기 (계속 편집)
          </Button>
        </DialogActions>
    </Dialog>
  );
}

function DiffRows({ diff, labels, testId }: { diff: ScriptDiff; labels: { before: string; after: string; removed: string; added: string }; testId: string }) {
  return (
    <div className="diff">
      {diff.rows.map((r, i) => (
        <div key={i} className={`diff-row ${r.kind}`} style={{ paddingLeft: 8 + r.depth * 20 }} data-testid={testId} data-kind={r.kind}>
          {r.kind === 'changed' ? (
            <>
              <span className="diff-before">
                {labels.before} {r.before}
              </span>
              <span className="diff-after">
                {labels.after} {r.after}
              </span>
            </>
          ) : r.kind === 'removed' ? (
            <span>
              {labels.removed} {r.before}
            </span>
          ) : r.kind === 'added' ? (
            <span>
              {labels.added} {r.after}
            </span>
          ) : (
            <span className="muted">  {r.after}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** 이력: versions (who · origin · memo) → step-sentence comparison with the previous version → revert. */
function HistoryView({ pid, apiBase, script, readOnly, onReverted }: { pid: string; apiBase: string; script: ScriptWithSource; readOnly: boolean; onReverted: (v: number, nv: number) => Promise<void> }) {
  const [versions, setVersions] = useState<ScriptVersionDto[] | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [cmp, setCmp] = useState<{ v: number; from: number | null; diff: ScriptDiff } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ versions: ScriptVersionDto[] }>('GET', `${apiBase}/versions`)
      .then((r) => {
        setVersions(r.versions);
        setSel(r.versions[0]?.version ?? null);
      })
      .catch((e) => setError(errorText(e)));
  }, [apiBase, script.version]);

  useEffect(() => {
    if (sel === null || !versions) return;
    const idx = versions.findIndex((v) => v.version === sel);
    const prev = versions[idx + 1]?.version ?? null;
    let stale = false;
    void (async () => {
      try {
        const parse = async (n: number) => {
          const v = await api<ScriptVersionDto>('GET', `${apiBase}/versions/${n}`);
          return (await checkSource(pid, { source: v.source ?? '' })).script ?? {};
        };
        const [after, before] = await Promise.all([parse(sel), prev !== null ? parse(prev) : Promise.resolve(undefined)]);
        if (!stale) setCmp({ v: sel, from: prev, diff: diffScripts(before, after) });
      } catch (e) {
        if (!stale) setError(errorText(e));
      }
    })();
    return () => {
      stale = true;
    };
  }, [sel, versions, apiBase, pid]);

  const revert = async (v: number) => {
    if (!window.confirm(`버전 ${v} 로 되돌릴까요? 그 내용으로 새 버전이 만들어지고, 이력은 지우지 않습니다.`)) return;
    try {
      const r = await api<{ version: ScriptVersionDto }>('POST', `${apiBase}/revert`, { version: v, baseVersion: script.version });
      await onReverted(v, r.version.version);
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'SCRIPT_CONFLICT' ? '그사이 다른 사람이 저장했습니다. 이력을 다시 확인하세요.' : errorText(e));
    }
  };

  if (error) return <p className="error">{error}</p>;
  if (!versions) return <p className="muted">불러오는 중…</p>;
  return (
    <div className="history-view" data-testid="history-view">
      <table className="version-list">
        <tbody>
          {versions.map((v) => (
            <tr key={v.version} className={sel === v.version ? 'sel link-row' : 'link-row'} onClick={() => setSel(v.version)} data-testid="version-row" data-version={v.version} data-origin={v.origin}>
              <td>
                <b>v{v.version}</b>
                {v.version === script.version && <Badge>현재</Badge>}
              </td>
              <td>
                <Badge>{ORIGIN_KO[v.origin] ?? v.origin}</Badge>
              </td>
              <td data-testid="version-author">{v.author?.name ?? '-'}</td>
              <td className="muted small">{fmtTime(v.createdAt)}</td>
              <td className="small">
                {v.memo ?? ''}
                {!v.validation.ok && <Badge tone="warn">검증 오류</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {cmp && (
        <div className="boxed compare-view" data-testid="compare-view" data-version={cmp.v}>
          <div className="row between">
            <b>
              {cmp.from !== null ? `v${cmp.from} → v${cmp.v}` : `v${cmp.v} (처음)`} · <span data-testid="compare-summary">{cmp.diff.summary}</span>
            </b>
            {!readOnly && (
              <Button icon={RotateCcw} onClick={() => void revert(cmp.v)} disabled={cmp.v === script.version} data-testid="version-revert">
                이 버전으로 되돌리기
              </Button>
            )}
          </div>
          {cmp.diff.header.length > 0 && <div className="small muted">머리 정보 변경: {cmp.diff.header.join(', ')}</div>}
          <DiffRows diff={cmp.diff} labels={{ before: '−', after: '+', removed: '−', added: '+' }} testId="diff-row" />
        </div>
      )}
    </div>
  );
}
