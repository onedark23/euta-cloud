// 실행 상세 (SPEC 실행 화면, route `/projects/:id/runs/:runId` — Teams cards and app notifications
// link here): live progress over the change feed (current step + elapsed), step timeline with step
// sentences / screenshots / expect results, metrics, console·network failures, report.html, file
// downloads, "파일 만료", cancel, re-run with the same settings. A test set (parent) run shows the set report
// (suite-report.tsx, ADR-032).
import type { PrecheckProblem, RunDetailDto, RunDto, RunFileDto, ScriptCheckDto, ScriptDto, ScriptVersionDto } from '@euta-cloud/shared';
import { describeStep } from '@euta/core/describe';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, errorText } from '../api';
import { fmtBytes, fmtDuration, fmtTime, isActiveRun, keyValuesText, SKIP_REASON_KO, SOURCE_KO, StatusBadge } from '../format';
import { encodePath, Link, navigate } from '../router';
import { koSecretRule } from '../script/messages';
import { feedData, useProject, useProjectEvents } from './context';
import { fileUrl, loadRunJsonSteps, parseEventLog, type ConsoleLine, type NetworkFailure, type StepFile } from './run-files';
import { ProblemList } from './run-panel';
import { RunTarget } from './runs';
import { ScriptName } from './script-name';
import { SuiteReport } from './suite-report';
import { scriptHref } from './scripts';
import { projectHref } from './shell';
import { ArrowLeft, Ban, ExternalLink, RotateCcw } from 'lucide-react';
import { Badge, buttonClass, Button, Card, Dialog, StepIcon } from '../ui';

const STATUS_ICON: Record<string, string> = { passed: '✔', failed: '✖', error: '✖', skipped: '–' };

/** Step object of a script by engine step id ("3", "4.2" — 1-based, groups nest). */
export function stepById(script: Record<string, unknown> | null, stepId: string): unknown {
  let list: unknown = script?.steps;
  let step: unknown;
  for (const part of stepId.split('.')) {
    const i = Number(part) - 1;
    if (!Array.isArray(list) || !Number.isInteger(i) || i < 0) return undefined;
    step = list[i];
    const g = step && typeof step === 'object' ? (step as { group?: { steps?: unknown } }).group : undefined;
    list = g?.steps;
  }
  return step;
}

function useTicker(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function RunDetail({ runId }: { runId: string }) {
  const { project, can } = useProject();
  const pid = project.id;
  const base = `/api/projects/${encodeURIComponent(pid)}/runs/${encodeURIComponent(runId)}`;
  const [run, setRun] = useState<(RunDetailDto & { retryRunId?: string | null }) | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [script, setScript] = useState<Record<string, unknown> | null>(null);
  const [fileSteps, setFileSteps] = useState<Record<string, StepFile>>({});
  const [files, setFiles] = useState<RunFileDto[] | null>(null);
  const [log, setLog] = useState<{ console: ConsoleLine[]; network: NetworkFailure[] } | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<PrecheckProblem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const filesFor = useRef<string | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<RunDetailDto & { retryRunId?: string | null }>('GET', base);
      setRun(r);
      return r;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError(errorText(e));
      return null;
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  // Files (run.json screenshots, steps.jsonl failures, file list) once the result is uploaded.
  useEffect(() => {
    if (!run) return;
    const key = `${run.id}:${run.resultFiles}`;
    if (filesFor.current === key) return;
    filesFor.current = key;
    if (run.resultFiles !== 'present') {
      setFiles(run.resultFiles === 'expired' ? [] : null);
      return;
    }
    void api<{ files: RunFileDto[] }>('GET', `${base}/files`).then((r) => setFiles(r.files)).catch(() => setFiles([]));
    void loadRunJsonSteps(pid, run.id).then(setFileSteps);
    void fetch(fileUrl(pid, run.id, 'steps.jsonl'), { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.text() : ''))
      .then((t) => setLog(parseEventLog(t)))
      .catch(() => setLog(null));
  }, [run, base, pid]);

  // Step sentences: the pinned script version (by script id → current path, renames included).
  const scriptKey = run?.script ? `${run.script.id}:${run.script.version}` : null;
  useEffect(() => {
    if (!run?.script?.id) return;
    const { id, version, path } = run.script;
    let stale = false;
    void (async () => {
      try {
        const list = await api<{ scripts: ScriptDto[] }>('GET', `/api/projects/${encodeURIComponent(pid)}/scripts`);
        const curPath = list.scripts.find((s) => s.id === id)?.path ?? path;
        const v = await api<ScriptVersionDto>('GET', `/api/projects/${encodeURIComponent(pid)}/scripts/${encodePath(curPath)}/versions/${version}`);
        const c = await api<ScriptCheckDto>('POST', `/api/projects/${encodeURIComponent(pid)}/scripts/check`, { source: v.source ?? '' });
        if (!stale) setScript(c.script);
      } catch {
        if (!stale) setScript(null);
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptKey, pid]);

  // Live: this run's (or its suite children's) feed events → refetch, throttled.
  useProjectEvents((e) => {
    if (e.kind !== 'resync') {
      const d = feedData(e) as { runId?: string; parentRunId?: string };
      if (!e.kind.startsWith('run.') || (d.runId !== runId && d.parentRunId !== runId)) return;
    }
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void load();
    }, 300);
  });
  // Fallback poll while active (SSE is the main path, ADR-022).
  const active = !!run && isActiveRun(run.status);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [active, load]);
  const now = useTicker(active);

  if (notFound) {
    return (
      <Card>
        <p>실행을 찾을 수 없습니다.</p>
        <Link href={projectHref(pid, '/runs')}>실행 이력</Link>
      </Card>
    );
  }
  if (!run) return error ? <p className="error">{error}</p> : <p className="muted">불러오는 중…</p>;

  const cancel = async () => {
    if (!window.confirm('이 실행을 취소할까요? 실행 중이면 그때까지의 결과를 올리고 멈춥니다.')) return;
    setBusy(true);
    try {
      await api('POST', `${base}/cancel`);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const rerun = async () => {
    setBusy(true);
    setError(null);
    setProblems(null);
    try {
      const body = {
        ...(run.kind === 'suite' ? { suiteId: run.suite?.id } : { scriptId: run.script?.id }),
        ...(run.environment.id ? { environmentId: run.environment.id } : {}),
        ...(Object.keys(run.vars).length ? { vars: run.vars } : {}),
        timeLimitSec: run.timeLimitSec,
      };
      const r = await api<RunDto>('POST', `/api/projects/${encodeURIComponent(pid)}/runs`, body);
      navigate(projectHref(pid, `/runs/${encodeURIComponent(r.id)}`));
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.details)) setProblems(e.details as PrecheckProblem[]);
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const elapsed = run.startedAt ? (run.finishedAt ? new Date(run.finishedAt).getTime() : now) - new Date(run.startedAt).getTime() : null;
  const canRerun = can('run.execute') && run.source !== 'local_upload' && (run.kind === 'suite' ? !!run.suite?.id : !!run.script?.id);
  const expectsBy = new Map<string, { condition: string; passed: boolean }[]>();
  for (const x of run.expects ?? []) expectsBy.set(x.stepId, [...(expectsBy.get(x.stepId) ?? []), x]);
  const curStep = run.currentStep;
  const curSentence = curStep ? (script ? describeStep(stepById(script, curStep.stepId)).sentence : (curStep.name ?? curStep.action)) : null;
  const report = files?.some((f) => f.path === 'report.html');
  // DSL `manual` steps (ADR-037): counted like report.html (reached or not); only reached ones get the badge.
  const manualCount = run.steps.filter((s) => s.manual).length;

  return (
    <Card as="div" className="run-detail" data-testid="run-detail" data-run-id={run.id} data-status={run.status}>
      <div className="row between">
        <Link href={projectHref(pid, '/runs')} className="back-link">
          <ArrowLeft size={14} aria-hidden="true" />
          실행 이력
        </Link>
        <code className="muted small">{run.id}</code>
      </div>
      <h2 className="row run-title">
        <StatusBadge status={run.status} flaky={run.flaky} skipReason={run.skipReason} />
        {run.kind === 'script' && run.script ? (
          <ScriptName name={run.script.name} path={run.script.path} href={run.script.id ? scriptHref(pid, run.script.path) : undefined} />
        ) : (
          <RunTarget run={run} />
        )}
        {run.script && <span className="muted small">v{run.script.version}</span>}
      </h2>

      <dl className="facts">
        <dt>환경</dt>
        <dd>{run.environment.name}</dd>
        <dt>출처</dt>
        <dd data-testid="run-source">{SOURCE_KO[run.source] ?? run.source}</dd>
        <dt>요청자</dt>
        <dd>{run.requestedBy.label}</dd>
        <dt>실행 위치</dt>
        <dd data-testid="run-location">{run.runnerLocation ?? '-'}</dd>
        <dt>요청</dt>
        <dd>{fmtTime(run.queuedAt)}</dd>
        <dt>시작</dt>
        <dd>{fmtTime(run.startedAt)}</dd>
        <dt>{active ? '경과' : '소요'}</dt>
        <dd data-testid="run-elapsed">{active ? fmtDuration(elapsed) : fmtDuration(run.durationMs)}</dd>
        {run.summary && (
          <>
            <dt>단계</dt>
            <dd data-testid="run-summary">
              {run.summary.passed}/{run.summary.total} 통과{run.summary.failed ? ` · 실패 ${run.summary.failed}` : ''}
              {run.summary.error ? ` · 오류 ${run.summary.error}` : ''}
              {run.summary.skipped ? ` · 건너뜀 ${run.summary.skipped}` : ''}
              {manualCount > 0 && (
                <Badge tone="manual" className="summary-manual" data-testid="run-manual-count" title="자동으로 확인하지 않은 단계 — 사람이 직접 확인하세요 (건너뜀 수에 포함)">
                  수동 확인 필요 {manualCount}
                </Badge>
              )}
            </dd>
          </>
        )}
        {Object.keys(run.vars).length > 0 && (
          <>
            <dt>변수</dt>
            <dd>
              <code>{keyValuesText(run.vars).replace(/\n/g, ' · ')}</code>
            </dd>
          </>
        )}
        <dt>시간 제한</dt>
        <dd>{fmtDuration(run.timeLimitSec * 1000)}</dd>
        {run.scheduledFor && (
          <>
            <dt>예약 회차</dt>
            <dd>{fmtTime(run.scheduledFor)}</dd>
          </>
        )}
        {run.skipReason && (
          <>
            <dt>건너뛴 이유</dt>
            <dd>{SKIP_REASON_KO[run.skipReason] ?? run.skipReason}</dd>
          </>
        )}
      </dl>
      <div className="row small">
        {run.retryOfRunId && <Link href={projectHref(pid, `/runs/${encodeURIComponent(run.retryOfRunId)}`)}>첫 시도 보기</Link>}
        {run.retryRunId && <Link href={projectHref(pid, `/runs/${encodeURIComponent(run.retryRunId)}`)}>재실행 보기</Link>}
        {run.parentRunId && <Link href={projectHref(pid, `/runs/${encodeURIComponent(run.parentRunId)}`)}>테스트 세트 실행 보기</Link>}
        {run.localModified && <Badge tone="warn">로컬 수정본 (클라우드 버전과 다름)</Badge>}
      </div>

      {active && (
        <div className="live boxed" data-testid="run-live">
          <b>{run.status === 'running' ? '실행 중' : '대기 중'}</b>
          {run.stopRequested && <Badge tone="warn">{run.stopRequested === 'cancel' ? '취소 요청됨' : '시간 초과 — 멈추는 중'}</Badge>}
          {curStep && (
            <span data-testid="run-current-step">
              {' '}
              · 지금 {curStep.stepId}번 단계: {curSentence}
            </span>
          )}
          <span className="muted"> · 끝난 단계 {run.steps.length}개</span>
        </div>
      )}

      <div className="row toolbar">
        {can('run.execute') && active && !run.stopRequested && (
          <Button variant="danger" icon={Ban} disabled={busy} onClick={() => void cancel()} data-testid="run-cancel">
            취소
          </Button>
        )}
        {canRerun && !active && (
          <Button variant="primary" icon={RotateCcw} disabled={busy} onClick={() => void rerun()} data-testid="run-rerun">
            같은 설정으로 다시 실행
          </Button>
        )}
        {report && (
          <a className={buttonClass()} href={`${base}/report`} target="_blank" rel="noreferrer" data-testid="run-report">
            <ExternalLink size={16} aria-hidden="true" />
            report.html 열기
          </a>
        )}
      </div>
      {problems && <ProblemList problems={problems} />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {run.error && <p className="error">{koSecretRule(run.error)}</p>}
      {run.resultFiles === 'expired' && (
        <p className="warn" data-testid="files-expired">
          파일 만료 — 보관 기간이 지나 스크린샷·리포트 등 결과 파일이 지워졌습니다. 요약·단계·지표는 남아 있습니다.
        </p>
      )}

      {run.kind === 'suite' && run.children && <SuiteReport run={run} pid={pid} onShot={setShot} />}

      {run.kind === 'script' && (
        <>
          <h3>단계</h3>
          {run.steps.length === 0 ? (
            <p className="muted">{active ? '아직 끝난 단계가 없습니다.' : '단계 기록이 없습니다.'}</p>
          ) : (
            <div className="step-list" data-testid="run-steps">
              {run.steps.map((s) => {
                const f = fileSteps[s.stepId];
                const d = script ? describeStep(stepById(script, s.stepId)) : null;
                const depth = s.stepId.split('.').length - 1;
                const manual = s.manual && !s.error; // reached manual step (not reached = skipped after a failure)
                return (
                  <div
                    key={`${s.stepId}-${s.index}`}
                    className={`step-card ${s.status}${manual ? ' manual' : ''}`}
                    style={{ marginLeft: depth * 24 }}
                    data-testid="run-step"
                    data-step-id={s.stepId}
                    data-status={s.status}
                    {...(s.manual ? { 'data-manual': manual ? 'reached' : 'unreached' } : {})}
                  >
                    <span className="step-no">{s.stepId}</span>
                    <StepIcon action={d?.action ?? s.action} />
                    <div className="step-main">
                      {(d?.title ?? s.name) && <div className="step-title">{d?.title ?? s.name}</div>}
                      <div className="step-sentence" data-testid="step-sentence">
                        {d?.sentence ?? (s.manual ? `수동 확인: ${s.manual.instruction}` : s.action)}
                      </div>
                      {s.manual?.reason && (
                        <div className="step-detail" data-testid="step-manual-reason">
                          이유: {s.manual.reason}
                        </div>
                      )}
                      {(expectsBy.get(s.stepId) ?? []).map((x, i) => (
                        <div key={i} className={x.passed ? 'step-detail' : 'step-error'}>
                          {x.passed ? '✔' : '✖'} {x.condition}
                        </div>
                      ))}
                      {s.error && <div className="step-error">{koSecretRule(s.error)}</div>}
                    </div>
                    <div className="step-ov">
                      {manual ? (
                        <Badge tone="manual" data-testid="step-manual">
                          수동 확인 필요
                        </Badge>
                      ) : (
                        <>
                          <span className={`ov-icon ${s.status}`}>{STATUS_ICON[s.status] ?? '·'}</span> {fmtDuration(s.durationMs)}
                        </>
                      )}
                      {f?.screenshot && (
                        <button type="button" className="thumb" onClick={() => setShot(fileUrl(pid, run.id, f.screenshot!))} title="스크린샷 크게 보기" data-testid="step-shot">
                          <img src={fileUrl(pid, run.id, f.screenshot)} alt={`${s.stepId}번 단계 스크린샷`} loading="lazy" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {run.metrics?.length > 0 && (
        <>
          <h3>지표</h3>
          <div className="table-wrap">
          <table data-testid="run-metrics">
            <thead>
              <tr>
                <th>이름</th>
                <th>값</th>
                <th>단계</th>
              </tr>
            </thead>
            <tbody>
              {run.metrics.map((m, i) => (
                <tr key={i}>
                  <td>{m.name}</td>
                  <td>
                    {Number.isInteger(m.value) ? m.value : m.value.toFixed(3)} {m.unit}
                  </td>
                  <td>{m.stepId ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      )}

      {log && (log.console.length > 0 || log.network.length > 0) && (
        <>
          <h3>콘솔·네트워크 실패</h3>
          <ul className="failures" data-testid="run-failures">
            {log.console.map((c, i) => (
              <li key={`c${i}`}>
                <Badge tone={c.level === 'error' ? 'bad' : 'warn'}>콘솔 {c.level === 'error' ? '오류' : '경고'}</Badge> {c.text}
                {c.stepId && <span className="muted small"> ({c.stepId}번 단계)</span>}
              </li>
            ))}
            {log.network.map((n, i) => (
              <li key={`n${i}`}>
                <Badge tone="bad">네트워크</Badge> {n.method} {n.url} {n.status ?? n.errorText ?? ''}
                {n.stepId && <span className="muted small"> ({n.stepId}번 단계)</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      {files && files.length > 0 && (
        <>
          <h3>결과 파일</h3>
          <table data-testid="run-files">
            <tbody>
              {files.map((f) => (
                <tr key={f.path}>
                  <td>
                    <a href={fileUrl(pid, run.id, f.path)} target="_blank" rel="noreferrer" download={f.path === 'report.html' ? undefined : f.path.split('/').pop()}>
                      {f.path}
                    </a>
                  </td>
                  <td className="muted small">{fmtBytes(f.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {shot && (
        <Dialog label="단계 스크린샷" className="shot-modal" onBackdropClick={() => setShot(null)} data-testid="shot-modal">
          <img src={shot} alt="단계 스크린샷" />
        </Dialog>
      )}
    </Card>
  );
}
