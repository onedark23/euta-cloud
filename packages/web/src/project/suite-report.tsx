// 테스트 세트 리포트 (SPEC 프로젝트-관리 "테스트 세트 리포트", ADR-032): the run detail of a set (parent) run —
// summary, comparison with the previous run of the same set in the same environment, per-script table and,
// per failed script, the failing step sentence, its error and its screenshot, and the scripts' "수동 확인 필요"
// steps (DSL `manual`, ADR-037). Data: the run's children +
// `GET …/runs/:runId/suite-report` (reloaded when a child changes).
import type { RunDetailDto, RunDto, SuiteReportDto, SuiteReportRef } from '@euta-cloud/shared';
import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { fmtDuration, fmtTime, RUN_STATUS_KO } from '../format';
import { Link } from '../router';
import { koSecretRule } from '../script/messages';
import { fileUrl } from './run-files';
import { projectHref } from './shell';
import { ExternalLink } from 'lucide-react';
import { Badge, buttonClass, runTone } from '../ui';
import { ScriptName } from './script-name';

const FAILED = new Set(['failed', 'error', 'timeout', 'aborted']);

function RunBadge({ status }: { status: string }) {
  return <Badge tone={runTone(status)}>{RUN_STATUS_KO[status] ?? status}</Badge>;
}

/** Script as people read it: `name:` bold, path small. */
export function SuiteReport({ run, pid, onShot }: { run: RunDetailDto; pid: string; onShot: (url: string) => void }) {
  const kids: RunDto[] = run.children ?? [];
  const [rep, setRep] = useState<SuiteReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${run.id}:${run.status}:${kids.map((k) => `${k.status}${k.resultFiles}`).join(',')}`;
  useEffect(() => {
    let alive = true;
    void api<SuiteReportDto>('GET', `/api/projects/${encodeURIComponent(pid)}/runs/${encodeURIComponent(run.id)}/suite-report`)
      .then((r) => alive && (setRep(r), setError(null)))
      .catch((e: unknown) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pid]);

  const nameOf = (runId: string) => rep?.names[runId];
  const passed = kids.filter((k) => k.status === 'passed').length;
  const failed = kids.filter((k) => FAILED.has(k.status)).length;
  const notRun = kids.filter((k) => k.status === 'cancelled' || k.status === 'skipped').length;
  const refs = (list: SuiteReportRef[]) =>
    list.length ? (
      <ul className="sr-refs">
        {list.map((x) => (
          <li key={x.order}>
            {x.order}. <ScriptName name={kids[x.order - 1] ? nameOf(kids[x.order - 1]!.id) : undefined} path={x.path} />
          </li>
        ))}
      </ul>
    ) : null;
  const c = rep?.comparison;
  const manual = rep?.manual ?? [];
  const manualBy = new Map<string, number>();
  for (const m of manual) manualBy.set(m.runId, (manualBy.get(m.runId) ?? 0) + 1);

  return (
    <div className="suite-report" data-testid="suite-report">
      <h3>요약</h3>
      <div className="sr-grid" data-testid="sr-summary">
        <div className="sr-card">
          통과<b data-testid="sr-passed">
            {passed}/{kids.length}
          </b>
        </div>
        <div className="sr-card">
          실패·오류<b>{failed}</b>
        </div>
        <div className="sr-card">
          실행 안 함(취소·건너뜀)<b>{notRun}</b>
        </div>
        {manual.length > 0 && (
          <div className="sr-card manual" data-testid="sr-manual-count" data-count={manual.length}>
            수동 확인 필요<b>{manual.length}</b>
          </div>
        )}
      </div>

      <h3>지난 실행 대비</h3>
      {!rep ? (
        <p className="muted">{error ?? '불러오는 중…'}</p>
      ) : !rep.previous || !c ? (
        <p className="muted" data-testid="sr-compare-none">
          같은 테스트 세트 · 같은 환경의 지난 실행이 없습니다.
        </p>
      ) : (
        <>
          <p className="muted small">
            지난 실행: <Link href={projectHref(pid, `/runs/${encodeURIComponent(rep.previous.id)}`)}>{fmtTime(rep.previous.startedAt ?? rep.previous.queuedAt)}</Link> <RunBadge status={rep.previous.status} /> (같은 테스트 세트 · 같은 환경)
          </p>
          <div className="sr-grid" data-testid="sr-compare">
            <div className={`sr-card${c.newlyFailing.length ? ' new' : ''}`} data-testid="sr-newly-failing" data-count={c.newlyFailing.length}>
              새로 실패<b>{c.newlyFailing.length}</b>
              {refs(c.newlyFailing)}
            </div>
            <div className={`sr-card${c.recovered.length ? ' rec' : ''}`} data-testid="sr-recovered" data-count={c.recovered.length}>
              회복<b>{c.recovered.length}</b>
              {refs(c.recovered)}
            </div>
            <div className="sr-card" data-testid="sr-still-failing" data-count={c.stillFailing.length}>
              계속 실패<b>{c.stillFailing.length}</b>
              {refs(c.stillFailing)}
            </div>
            <div className="sr-card" data-testid="sr-still-passing" data-count={c.stillPassing.length}>
              그대로 통과<b>{c.stillPassing.length}</b>
              {refs(c.stillPassing)}
            </div>
          </div>
        </>
      )}

      <h3>스크립트별 결과</h3>
      {kids.length === 0 ? (
        <p className="muted">아직 없습니다.</p>
      ) : (
        <div className="table-wrap">
        <table data-testid="run-table">
          <thead>
            <tr>
              <th>#</th>
              <th>스크립트</th>
              <th>상태</th>
              <th>소요</th>
              <th>항상 실행</th>
              <th>개별 실행</th>
            </tr>
          </thead>
          <tbody>
            {kids.map((k, i) => (
              <tr key={k.id} data-testid="run-row" data-run-id={k.id} data-status={k.status}>
                <td>{i + 1}</td>
                <td>
                  <ScriptName name={nameOf(k.id)} path={k.script?.path ?? '?'} />
                </td>
                <td>
                  <RunBadge status={k.status} />
                  {manualBy.has(k.id) && (
                    <Badge tone="manual" data-testid="run-manual-count">
                      수동 확인 필요 {manualBy.get(k.id)}
                    </Badge>
                  )}
                </td>
                <td className="small">{fmtDuration(k.durationMs)}</td>
                <td>
                  {k.alwaysRun && (
                    <Badge data-testid="run-always" title="테스트 세트를 취소해도 실행합니다">
                      항상 실행
                    </Badge>
                  )}
                </td>
                <td>
                  <Link className={buttonClass('secondary', 'sm')} href={projectHref(pid, `/runs/${encodeURIComponent(k.id)}`)}>
                    <ExternalLink size={14} aria-hidden="true" />
                    열기
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {manual.length > 0 && (
        <>
          <h3>수동 확인 필요</h3>
          <p className="muted small">자동으로 확인하지 않은 단계입니다. 사람이 직접 확인하세요 (건너뜀 수에 포함, 실행 상태에는 영향 없음).</p>
          <div className="table-wrap">
            <table data-testid="sr-manual">
              <thead>
                <tr>
                  <th>스크립트</th>
                  <th>단계</th>
                  <th>확인할 내용</th>
                  <th>이유</th>
                  <th>개별 실행</th>
                </tr>
              </thead>
              <tbody>
                {manual.map((m) => (
                  <tr key={`${m.runId}-${m.stepId}`} data-testid="sr-manual-row" data-reached={m.reached}>
                    <td>
                      {m.order}. <ScriptName name={nameOf(m.runId)} path={m.path} />
                    </td>
                    <td>
                      {m.stepId}
                      {m.title ? ` · ${m.title}` : ''}
                      {!m.reached && <div className="muted small">실행 안 됨 (앞 단계 실패)</div>}
                    </td>
                    <td>{m.instruction}</td>
                    <td className="muted">{m.reason ?? ''}</td>
                    <td>
                      <Link className={buttonClass('secondary', 'sm')} href={projectHref(pid, `/runs/${encodeURIComponent(m.runId)}`)}>
                        <ExternalLink size={14} aria-hidden="true" />
                        열기
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3>실패 상세</h3>
      {!rep ? null : rep.failures.length === 0 ? (
        <p className="muted">실패한 스크립트가 없습니다.</p>
      ) : (
        rep.failures.map((f) => (
          <section key={f.runId} className="sr-fail" data-testid="sr-failure" data-order={f.order}>
            <div className="row">
              <b>{f.order}.</b> <ScriptName name={nameOf(f.runId)} path={f.path} /> <RunBadge status={f.status} />
            </div>
            <div className="muted small">{f.stepId ? `실패한 단계 ${f.stepId}${f.title ? ` · ${f.title}` : ''}` : '실패한 단계 정보 없음 (실행 전 오류)'}</div>
            {f.sentence && (
              <div className="sr-sentence" data-testid="sr-step-sentence">
                {f.sentence}
              </div>
            )}
            {f.error && <pre data-testid="sr-error">{koSecretRule(f.error)}</pre>}
            {f.screenshot ? (
              <button type="button" className="sr-shot" onClick={() => onShot(fileUrl(pid, f.runId, f.screenshot!))} title="스크린샷 크게 보기" data-testid="sr-shot">
                <img src={fileUrl(pid, f.runId, f.screenshot)} alt={`${f.order}번 스크립트 ${f.stepId ?? ''}단계 스크린샷`} loading="lazy" />
              </button>
            ) : (
              <div className="muted small">이 단계의 스크린샷이 없습니다.</div>
            )}
          </section>
        ))
      )}
    </div>
  );
}
