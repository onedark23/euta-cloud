// 예약 (SPEC 예약): 목록(다음 실행 · 최근 결과 · 소요 시간 경고) · 만들기/고치기(프리셋 주기 또는 cron,
// Asia/Seoul, 최소 간격 10분 — 서버가 판정) · 켜기/끄기 · 삭제. 편집자 이상만 바꿀 수 있다.
import { SCHEDULE_MIN_INTERVAL_MIN, type Cadence, type ScheduleDto, type ScriptDto } from '@euta-cloud/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, errorText } from '../api';
import { cadenceText, fmtDuration, fmtTime, StatusBadge } from '../format';
import { Link } from '../router';
import { useProject, useProjectEvents } from './context';
import { projectHref } from './shell';
import type { SuiteDto } from './suites';
import { CalendarClock, Pencil, Plus, Power, Save, Trash, X } from 'lucide-react';
import { Badge, Button, Card, Checkbox, EmptyState, Select, Switch, TextField } from '../ui';
import { ScriptName, ScriptPicker } from './script-name';

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

interface Draft {
  id?: string;
  name: string;
  targetKind: 'script' | 'suite';
  targetId: string;
  environmentId: string;
  kind: Cadence['kind'];
  time: string;
  minute: string;
  dayOfWeek: number;
  expression: string;
  limitMin: string;
  retry: boolean;
  enabled: boolean;
}

const emptyDraft = (): Draft => ({ name: '', targetKind: 'script', targetId: '', environmentId: '', kind: 'daily', time: '09:00', minute: '0', dayOfWeek: 1, expression: '0 9 * * 1-5', limitMin: '', retry: false, enabled: true });

function draftOf(s: ScheduleDto): Draft {
  const c = s.cadence;
  return {
    id: s.id,
    name: s.name,
    targetKind: s.target.kind,
    targetId: (s.target.kind === 'script' ? s.target.script.id : s.target.suite.id) ?? '',
    environmentId: s.environment.id ?? '',
    kind: c.kind,
    time: 'time' in c ? c.time : '09:00',
    minute: c.kind === 'hourly' ? String(c.minute) : '0',
    dayOfWeek: c.kind === 'weekly' ? c.dayOfWeek : 1,
    expression: c.kind === 'cron' ? c.expression : s.cron,
    limitMin: s.timeLimitSec ? String(Math.round(s.timeLimitSec / 60)) : '',
    retry: s.retryOnFailure,
    enabled: s.enabled,
  };
}

function cadenceOf(d: Draft): Cadence {
  switch (d.kind) {
    case 'hourly':
      return { kind: 'hourly', minute: Number(d.minute) || 0 };
    case 'daily':
      return { kind: 'daily', time: d.time };
    case 'weekdays':
      return { kind: 'weekdays', time: d.time };
    case 'weekly':
      return { kind: 'weekly', dayOfWeek: d.dayOfWeek, time: d.time };
    case 'cron':
      return { kind: 'cron', expression: d.expression };
  }
}

function TargetLabel({ s }: { s: ScheduleDto }) {
  if (s.target.kind === 'suite') return <>테스트 세트 {s.target.suite.name ?? '(삭제됨)'}</>;
  const { path, name } = s.target.script;
  return path ? <ScriptName name={name} path={path} /> : <span className="muted">(삭제된 스크립트)</span>;
}

export function SchedulesTab() {
  const { project, environments, can } = useProject();
  const pid = project.id;
  const editable = can('schedule.manage');
  const [list, setList] = useState<ScheduleDto[] | null>(null);
  const [scripts, setScripts] = useState<ScriptDto[]>([]);
  const [suites, setSuites] = useState<SuiteDto[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setList((await api<{ schedules: ScheduleDto[] }>('GET', `/api/projects/${encodeURIComponent(pid)}/schedules`)).schedules);
    } catch (e) {
      setError(errorText(e));
    }
  }, [pid]);
  useEffect(() => {
    void load();
  }, [load]);
  useProjectEvents((e) => {
    if (e.kind === 'resync' || e.kind.startsWith('schedule.') || e.kind === 'run.finished' || e.kind === 'run.skipped') void load();
  });

  const openForm = async (d: Draft) => {
    setFormError(null);
    setDraft(d);
    try {
      const [s, su] = await Promise.all([
        api<{ scripts: ScriptDto[] }>('GET', `/api/projects/${encodeURIComponent(pid)}/scripts`),
        api<{ suites: SuiteDto[] }>('GET', `/api/projects/${encodeURIComponent(pid)}/suites`),
      ]);
      setScripts(s.scripts);
      setSuites(su.suites);
      // A test set defaults to the first one; a script is picked by checking it (search + check).
      setDraft((cur) => (cur && !cur.targetId && cur.targetKind === 'suite' ? { ...cur, targetId: su.suites[0]?.id ?? '' } : cur));
    } catch (e) {
      setFormError(errorText(e));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setFormError(null);
    const body = {
      name: draft.name.trim(),
      ...(draft.targetKind === 'script' ? { scriptId: draft.targetId } : { suiteId: draft.targetId }),
      ...(draft.environmentId ? { environmentId: draft.environmentId } : {}),
      cadence: cadenceOf(draft),
      timeLimitSec: draft.limitMin.trim() ? Math.round(Number(draft.limitMin) * 60) : null,
      retryOnFailure: draft.retry,
      enabled: draft.enabled,
    };
    try {
      if (draft.id) await api('PATCH', `/api/projects/${encodeURIComponent(pid)}/schedules/${encodeURIComponent(draft.id)}`, body);
      else await api('POST', `/api/projects/${encodeURIComponent(pid)}/schedules`, body);
      setDraft(null);
      await load();
    } catch (err) {
      const issues = err instanceof ApiError && Array.isArray(err.details) ? (err.details as { path: string; message: string }[]) : [];
      setFormError(issues.length ? issues.map((i) => (i.path === 'cadence' ? `주기: ${i.message}` : `${i.path}: ${i.message}`)).join(' / ') : errorText(err));
    }
  };

  const toggle = async (s: ScheduleDto) => {
    try {
      await api('PATCH', `/api/projects/${encodeURIComponent(pid)}/schedules/${encodeURIComponent(s.id)}`, { enabled: !s.enabled });
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const remove = async (s: ScheduleDto) => {
    if (!window.confirm(`예약 "${s.name}" 을(를) 삭제할까요? 지난 실행 기록은 남습니다.`)) return;
    try {
      await api('DELETE', `/api/projects/${encodeURIComponent(pid)}/schedules/${encodeURIComponent(s.id)}`);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const set = (p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  return (
    <Card>
      <div className="row between toolbar">
        <p className="muted small">모든 예약은 Asia/Seoul 시간 기준, 같은 예약의 회차 사이는 {SCHEDULE_MIN_INTERVAL_MIN}분 이상. 이전 회차가 아직 실행 중이면 그 회차는 건너뜁니다.</p>
        {editable && !draft && (
          <Button variant="primary" icon={Plus} onClick={() => void openForm(emptyDraft())} data-testid="new-schedule">
            새 예약
          </Button>
        )}
      </div>
      {draft && (
        <form className="boxed schedule-form" onSubmit={submit} data-testid="schedule-form">
          <div className="inline">
            <TextField label="이름" className="grow" name="schedule-name" required maxLength={80} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            <Select
              label="대상"
              value={draft.targetKind}
              onChange={(e) => set({ targetKind: e.target.value as Draft['targetKind'], targetId: e.target.value === 'suite' ? (suites[0]?.id ?? '') : '' })}
              data-testid="schedule-target-kind"
            >
              <option value="script">스크립트</option>
              <option value="suite">테스트 세트</option>
            </Select>
            {draft.targetKind === 'suite' && (
              <Select label="테스트 세트" value={draft.targetId} onChange={(e) => set({ targetId: e.target.value })} data-testid="schedule-target">
                {suites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
            <Select label="환경" value={draft.environmentId} onChange={(e) => set({ environmentId: e.target.value })} data-testid="schedule-env">
              <option value="">(기본 환경)</option>
              {environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          </div>
          {draft.targetKind === 'script' && (
            <ScriptPicker
              scripts={scripts}
              picked={draft.targetId ? [draft.targetId] : []}
              onChange={(ids) => set({ targetId: ids[0] ?? '' })}
              single
              label="실행할 스크립트 찾기 (이름 또는 경로) — 하나를 체크하세요"
              testId="schedule-target"
            />
          )}
          <div className="inline">
            <Select label="주기" value={draft.kind} onChange={(e) => set({ kind: e.target.value as Cadence['kind'] })} data-testid="schedule-kind">
              <option value="hourly">매시간</option>
              <option value="daily">매일</option>
              <option value="weekdays">평일</option>
              <option value="weekly">매주</option>
              <option value="cron">직접 입력 (cron)</option>
            </Select>
            {draft.kind === 'hourly' && <TextField label="분" inputClassName="num" value={draft.minute} onChange={(e) => set({ minute: e.target.value })} />}
            {draft.kind === 'weekly' && (
              <Select label="요일" value={draft.dayOfWeek} onChange={(e) => set({ dayOfWeek: Number(e.target.value) })}>
                {DAYS.map((d, i) => (
                  <option key={i} value={i}>
                    {d}
                  </option>
                ))}
              </Select>
            )}
            {(draft.kind === 'daily' || draft.kind === 'weekdays' || draft.kind === 'weekly') && (
              <TextField label="시각" type="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} data-testid="schedule-time" />
            )}
            {draft.kind === 'cron' && (
              <TextField label="cron (분 시 일 월 요일)" className="grow" value={draft.expression} onChange={(e) => set({ expression: e.target.value })} placeholder="*/30 9-18 * * 1-5" />
            )}
            <TextField
              label="시간 제한(분)"
              inputClassName="num"
              value={draft.limitMin}
              onChange={(e) => set({ limitMin: e.target.value })}
              placeholder={String(Math.round(project.runTimeLimitSec / 60))}
            />
            <Checkbox label="실패 시 1회 재실행" checked={draft.retry} onChange={(e) => set({ retry: e.target.checked })} />
            <Switch label="켜기" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          </div>
          <div className="row">
            <Button type="submit" variant="primary" icon={draft.id ? Save : Plus} disabled={!draft.name.trim() || !draft.targetId} data-testid="schedule-save">
              {draft.id ? '저장' : '만들기'}
            </Button>
            <Button icon={X} onClick={() => setDraft(null)}>
              취소
            </Button>
            {formError && (
              <span className="error" role="alert">
                {formError}
              </span>
            )}
          </div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
      {list === null ? (
        <p className="muted">불러오는 중…</p>
      ) : list.length === 0 ? (
        <EmptyState icon={CalendarClock} title="예약이 없습니다." />
      ) : (
        <div className="table-wrap">
        <table data-testid="schedule-table">
          <thead>
            <tr>
              <th>이름</th>
              <th>대상 · 환경</th>
              <th>주기</th>
              <th>다음 실행</th>
              <th>최근 결과</th>
              <th>상태</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id} data-testid="schedule-row" data-name={s.name}>
                <td>
                  <b>{s.name}</b>
                  <div className="muted small">만든 사람 {s.createdBy.label}</div>
                </td>
                <td className="small">
                  <TargetLabel s={s} /> · {s.environment.name ?? '(환경 없음)'}
                  {s.retryOnFailure && <Badge>재실행 1회</Badge>}
                </td>
                <td className="small">{cadenceText(s.cadence)}</td>
                <td className="small" data-testid="schedule-next">
                  {s.enabled ? fmtTime(s.nextRunAt) : '-'}
                  {s.durationWarning && (
                    <div className="warn" data-testid="schedule-duration-warning">
                      최근 3회 평균 {fmtDuration(s.durationWarning.avgDurationMs)} — 주기({fmtDuration(s.durationWarning.intervalMs)})보다 깁니다
                    </div>
                  )}
                </td>
                <td>
                  {s.lastRun ? (
                    <Link href={projectHref(pid, `/runs/${encodeURIComponent(s.lastRun.id)}`)}>
                      <StatusBadge status={s.lastRun.status} flaky={s.lastRun.flaky} skipReason={s.lastRun.skipReason} />
                    </Link>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </td>
                <td>
                  {s.enabled ? <Badge tone="ok">켜짐</Badge> : <Badge tone="idle">꺼짐{s.disabledReason === 'project_trashed' ? ' (휴지통)' : ''}</Badge>}
                </td>
                <td>
                  {editable && (
                    <div className="row actions">
                      <Button size="sm" icon={Power} onClick={() => void toggle(s)} data-testid="schedule-toggle">
                        {s.enabled ? '끄기' : '켜기'}
                      </Button>
                      <Button size="sm" icon={Pencil} onClick={() => void openForm(draftOf(s))}>
                        고치기
                      </Button>
                      <Button size="sm" variant="danger" icon={Trash} onClick={() => void remove(s)}>
                        삭제
                      </Button>
                    </div>
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
