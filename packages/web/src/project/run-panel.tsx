// Run request (SPEC 실행 요청 · 사전 검사): environment + vars (+ time limit), the server precheck
// reasons shown before the run button (`POST …/runs/precheck`, editor+), then `POST …/runs`.
import type { PrecheckProblem, PrecheckResultDto, RunDetailDto } from '@euta-cloud/shared';
import { useEffect, useState } from 'react';
import { api, ApiError, errorText } from '../api';
import { parseKeyValues } from '../format';
import { navigate } from '../router';
import { koSecretRule } from '../script/messages';
import { useProject } from './context';
import { projectHref } from './shell';
import { Play } from 'lucide-react';
import { Button, Select, TextArea, TextField } from '../ui';

const PRECHECK_KO: Record<string, string> = {
  ENVIRONMENT_REQUIRED: '환경을 고르세요 (프로젝트 기본 환경이 없습니다)',
  SCRIPT_INVALID: '스크립트 검증 오류',
  OS_INPUT_NOT_ALLOWED: '클라우드에서는 OS 입력(input: os)을 쓸 수 없습니다',
  SECRET_PLACEMENT: '테스트 계정(${secrets.*})은 입력 스텝 값에만 쓸 수 있습니다',
  CREDENTIALS_MISSING: '환경에 없는 테스트 계정',
  TARGET_NOT_PUBLIC: '클라우드에서 접속할 수 없는 주소입니다 (사설·사내 주소)',
};

export function problemText(p: PrecheckProblem): string {
  const head = PRECHECK_KO[p.code] ?? p.message;
  const names = p.names?.length ? `: ${p.names.join(', ')}` : '';
  const where = p.script ? ` (${p.script})` : '';
  return `${head}${names}${where}`;
}

export function ProblemList({ problems }: { problems: PrecheckProblem[] }) {
  return (
    <ul className="problems" data-testid="precheck-problems">
      {problems.map((p, i) => (
        <li key={i} data-code={p.code}>
          {problemText(p)}
          {p.issues && p.issues.length > 0 && (
            <ul>
              {p.issues.slice(0, 10).map((x, j) => (
                <li key={j} className="small">
                  {x.path ? `${x.path}: ` : ''}
                  {koSecretRule(x.message)}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface RunTarget {
  scriptId?: string;
  suiteId?: string;
}

/** Inline run form. Hidden entirely for callers without `run.execute` (viewer). */
export function RunPanel({ target, defaultEnvId, initialVars = '', compact }: { target: RunTarget; defaultEnvId?: string | null; initialVars?: string; compact?: boolean }) {
  const { project, environments, can } = useProject();
  const [envId, setEnvId] = useState<string>(defaultEnvId ?? project.defaultEnvironmentId ?? environments[0]?.id ?? '');
  const [varsText, setVarsText] = useState(initialVars);
  const [limitMin, setLimitMin] = useState('');
  const [pre, setPre] = useState<PrecheckResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = parseKeyValues(varsText);
  const allowed = can('run.execute');
  const body = () => ({
    ...target,
    ...(envId ? { environmentId: envId } : {}),
    ...(Object.keys(parsed.values).length ? { vars: parsed.values } : {}),
    ...(limitMin.trim() ? { timeLimitSec: Math.round(Number(limitMin) * 60) } : {}),
  });
  const key = JSON.stringify(body());

  useEffect(() => {
    if (!allowed) return;
    let stale = false;
    const t = setTimeout(() => {
      api<PrecheckResultDto>('POST', `/api/projects/${encodeURIComponent(project.id)}/runs/precheck`, JSON.parse(key))
        .then((r) => !stale && (setPre(r), setError(null)))
        .catch((e) => !stale && setError(errorText(e)));
    }, 250);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [key, allowed, project.id]);

  if (!allowed) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<RunDetailDto>('POST', `/api/projects/${encodeURIComponent(project.id)}/runs`, body());
      navigate(projectHref(project.id, `/runs/${encodeURIComponent(r.id)}`));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DAILY_RUN_CAP_REACHED') {
        const d = e.details as { cap?: number; used?: number } | undefined;
        setError(`오늘 실행 상한에 도달했습니다 (${d?.used ?? '?'}/${d?.cap ?? '?'}) — 설정에서 하루 실행 상한을 바꿀 수 있습니다.`);
      } else if (e instanceof ApiError && Array.isArray(e.details)) {
        setPre({ ok: false, problems: e.details as PrecheckProblem[], environment: null, credentialNames: [], scripts: [] });
      } else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const limitBad = limitMin.trim() !== '' && !(Number(limitMin) >= 1 && Number(limitMin) <= 1440);
  return (
    <div className={compact ? 'run-panel compact' : 'run-panel boxed'} data-testid="run-panel">
      <div className="inline">
        <Select label="환경" value={envId} onChange={(e) => setEnvId(e.target.value)} data-testid="run-env">
          {environments.length === 0 && <option value="">(환경 없음)</option>}
          {environments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
              {e.cloudRunnable ? '' : ' (클라우드 실행 불가)'}
            </option>
          ))}
        </Select>
        <TextArea
          label="변수 덮어쓰기"
          help="한 줄에 이름=값"
          className="grow"
          rows={compact ? 1 : 2}
          value={varsText}
          onChange={(e) => setVarsText(e.target.value)}
          placeholder="keyword=노트북"
          data-testid="run-vars"
        />
        <TextField
          label="시간 제한(분)"
          help="비우면 프로젝트 기본"
          inputClassName="num"
          value={limitMin}
          onChange={(e) => setLimitMin(e.target.value)}
          placeholder={String(Math.round(project.runTimeLimitSec / 60))}
        />
        <Button variant="primary" icon={Play} disabled={busy || !pre?.ok || parsed.bad.length > 0 || limitBad} onClick={() => void run()} data-testid="run-start">
          클라우드에서 실행
        </Button>
      </div>
      {parsed.bad.length > 0 && <p className="error small">변수 형식이 아닙니다: {parsed.bad.join(', ')}</p>}
      {limitBad && <p className="error small">시간 제한은 1~1440분입니다.</p>}
      {pre && !pre.ok && <ProblemList problems={pre.problems} />}
      {pre?.ok && <p className="ok small" data-testid="precheck-ok">사전 검사 통과{pre.credentialNames.length ? ` · 테스트 계정: ${pre.credentialNames.join(', ')}` : ''}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
