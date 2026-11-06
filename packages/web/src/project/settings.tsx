// 설정 (SPEC 계정 "웹 화면" 설정): 기본 정보 · 환경(허용 도메인 · 공개 주소 경고) · 테스트 계정(쓰기 전용 —
// 이름·마지막 변경만) · 공개 범위·권한 요청·구성원(members.tsx) · 알림(Teams webhook 은 편집자 이상에게만 —
// 서버가 응답에 실을 때만 보임) · 테스트 규칙 · 하루 실행 상한 · 삭제(소유자, 이름 입력).
import {
  BROWSER_ENGINES,
  CREDENTIAL_NAME,
  DAILY_RUN_CAP_MAX,
  type CredentialDto,
  type EnvironmentDto,
  type ProjectDto,
} from '@euta-cloud/shared';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiError, errorText } from '../api';
import { fmtTime, keyValuesText, parseKeyValues } from '../format';
import { navigate } from '../router';
import { useProject } from './context';
import { MembersSection } from './members';
import { KeyRound, Pencil, Plus, Save, Trash, X } from 'lucide-react';
import { Badge, Button, Card, Checkbox, Select, Switch, TextArea, TextField } from '../ui';

const issuesText = (e: unknown) =>
  e instanceof ApiError && Array.isArray(e.details) && e.details.length
    ? (e.details as { path?: string; message: string }[]).map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join(' / ')
    : errorText(e);

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <Card className="settings-section" data-testid={testId}>
      <h3>{title}</h3>
      {children}
    </Card>
  );
}

export function SettingsTab() {
  const { project, can } = useProject();
  return (
    <div className="settings">
      {!can('project.update') && <p className="muted settings-note">보기 전용 — 설정을 바꾸려면 프로젝트 편집자 이상이어야 합니다.</p>}
      <BasicInfo />
      <Environments />
      <MembersSection />
      <Notifications />
      <Rules />
      {can('project.delete') && <DeleteProject key={project.id} />}
    </div>
  );
}

function useSaver() {
  const { project, reload } = useProject();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (body: Record<string, unknown>, okText = '저장했습니다') => {
    setMsg(null);
    try {
      await api('PATCH', `/api/projects/${encodeURIComponent(project.id)}`, body);
      await reload();
      setMsg({ ok: true, text: okText });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: issuesText(e) });
      return false;
    }
  };
  const view = msg ? (
    <span className={msg.ok ? 'ok small' : 'error small'} role={msg.ok ? 'status' : 'alert'}>
      {msg.text}
    </span>
  ) : null;
  return { save, view };
}

function BasicInfo() {
  const { project, environments, can } = useProject();
  const ro = !can('project.update');
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [engine, setEngine] = useState<string>(project.browser.engine);
  const [device, setDevice] = useState(project.browser.device ?? '');
  const [limitMin, setLimitMin] = useState(String(Math.round(project.runTimeLimitSec / 60)));
  const [defEnv, setDefEnv] = useState(project.defaultEnvironmentId ?? '');
  const { save, view } = useSaver();
  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
    setEngine(project.browser.engine);
    setDevice(project.browser.device ?? '');
    setLimitMin(String(Math.round(project.runTimeLimitSec / 60)));
    setDefEnv(project.defaultEnvironmentId ?? '');
  }, [project]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save({
      name: name.trim(),
      description,
      browser: { engine, ...(device.trim() ? { device: device.trim() } : {}) },
      runTimeLimitSec: Math.round(Number(limitMin) * 60),
      defaultEnvironmentId: defEnv || null,
    });
  };
  return (
    <Section title="기본 정보" testId="settings-basic">
      <form onSubmit={submit}>
        <fieldset disabled={ro} className="inline">
          <TextField label="이름" name="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <TextField label="설명" className="grow" name="description" maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
          <Select label="기본 브라우저" value={engine} onChange={(e) => setEngine(e.target.value)}>
            {BROWSER_ENGINES.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </Select>
          <TextField label="기본 기기 (선택)" value={device} onChange={(e) => setDevice(e.target.value)} placeholder="예: iPhone 15" />
          <TextField label="실행 시간 제한(분)" inputClassName="num" value={limitMin} onChange={(e) => setLimitMin(e.target.value)} />
          <Select label="기본 환경" value={defEnv} onChange={(e) => setDefEnv(e.target.value)} data-testid="default-env">
            <option value="">(없음)</option>
            {environments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
          {!ro && (
            <Button type="submit" icon={Save}>
              저장
            </Button>
          )}
        </fieldset>
      </form>
      {view}
    </Section>
  );
}

// ── Environments + test credentials ─────────────────────────────────────────

interface EnvDraft {
  id?: string;
  name: string;
  baseUrl: string;
  vars: string;
  domains: string;
  makeDefault: boolean;
}

function Environments() {
  const { project, environments, can, reload } = useProject();
  const editable = can('environment.edit');
  const [draft, setDraft] = useState<EnvDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setError(null);
    const vars = parseKeyValues(draft.vars);
    if (vars.bad.length) return setError(`변수 형식이 아닙니다: ${vars.bad.join(', ')}`);
    const domains = draft.domains
      .split(/[\s,]+/)
      .map((d) => d.trim())
      .filter(Boolean);
    const body = { name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), vars: vars.values, ...(draft.id || domains.length ? { allowedDomains: domains } : {}), makeDefault: draft.makeDefault };
    try {
      if (draft.id) await api('PATCH', `/api/projects/${encodeURIComponent(project.id)}/environments/${encodeURIComponent(draft.id)}`, body);
      else await api('POST', `/api/projects/${encodeURIComponent(project.id)}/environments`, body);
      setDraft(null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'NAME_TAKEN' ? `같은 이름의 환경이 있습니다: ${draft.name}` : issuesText(err));
    }
  };

  const remove = async (env: EnvironmentDto) => {
    if (!window.confirm(`환경 "${env.name}" 을(를) 삭제할까요? 이 환경의 테스트 계정도 함께 지워지고, 이 환경을 쓰는 예약은 회차 때 오류로 기록됩니다.`)) return;
    try {
      await api('DELETE', `/api/projects/${encodeURIComponent(project.id)}/environments/${encodeURIComponent(env.id)}`);
      await reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <Section title="환경 · 테스트 계정" testId="settings-environments">
      {environments.length === 0 && <p className="muted">환경이 없습니다. 실행하려면 환경(대상 주소)을 하나 이상 만드세요.</p>}
      {environments.map((env) =>
        draft?.id === env.id ? null : (
          <div key={env.id} className="boxed env" data-testid="env-row" data-name={env.name}>
            <div className="row between">
              <div>
                <b>{env.name}</b> {env.isDefault && <Badge>기본</Badge>} <code className="small">{env.baseUrl}</code>
              </div>
              {editable && (
                <div className="row">
                  <Button
                    size="sm"
                    icon={Pencil}
                    onClick={() => setDraft({ id: env.id, name: env.name, baseUrl: env.baseUrl, vars: keyValuesText(env.vars), domains: env.allowedDomains.join(', '), makeDefault: env.isDefault })}
                  >
                    고치기
                  </Button>
                  <Button size="sm" variant="danger" icon={Trash} onClick={() => void remove(env)}>
                    삭제
                  </Button>
                </div>
              )}
            </div>
            {!env.cloudRunnable && (
              <p className="warn small" data-testid="env-not-public">
                공개 주소가 아닙니다{env.addressCheck.reason ? ` (${env.addressCheck.reason})` : ''} — 이 환경은 클라우드에서 실행할 수 없습니다(로컬 앱 실행은 가능).
              </p>
            )}
            <div className="small muted">
              허용 도메인(테스트 계정 입력 가능): {env.allowedDomains.length ? env.allowedDomains.join(', ') : '(없음 — 어떤 페이지에도 테스트 계정을 입력하지 않음)'}
            </div>
            {Object.keys(env.vars).length > 0 && (
              <div className="small muted">
                변수: <code>{Object.keys(env.vars).join(', ')}</code>
              </div>
            )}
            <Credentials env={env} editable={can('credential.write')} />
          </div>
        ),
      )}
      {draft && (
        <form className="boxed" onSubmit={submit} data-testid="env-form">
          <div className="inline">
            <TextField label="이름" name="env-name" required maxLength={40} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="dev" />
            <TextField label="주소" className="grow" name="env-url" required value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} placeholder="https://dev.example.com" />
            <Checkbox label="기본 환경" checked={draft.makeDefault} onChange={(e) => setDraft({ ...draft, makeDefault: e.target.checked })} />
          </div>
          <div className="inline">
            <TextArea
              label="변수"
              help="한 줄에 이름=값 — 비밀번호·토큰은 변수가 아니라 테스트 계정으로"
              className="grow"
              rows={3}
              value={draft.vars}
              onChange={(e) => setDraft({ ...draft, vars: e.target.value })}
            />
            <TextArea
              label="허용 도메인"
              help="쉼표로 — 비우면 주소의 도메인. SSO·결제 도메인은 추가"
              className="grow"
              rows={3}
              value={draft.domains}
              onChange={(e) => setDraft({ ...draft, domains: e.target.value })}
              name="env-domains"
            />
          </div>
          <div className="row">
            <Button type="submit" variant="primary" icon={draft.id ? Save : Plus}>
              {draft.id ? '저장' : '추가'}
            </Button>
            <Button icon={X} onClick={() => setDraft(null)}>
              취소
            </Button>
          </div>
        </form>
      )}
      {editable && !draft && (
        <Button icon={Plus} onClick={() => setDraft({ name: '', baseUrl: '', vars: '', domains: '', makeDefault: environments.length === 0 })} data-testid="new-env">
          환경 추가
        </Button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}

function Credentials({ env, editable }: { env: EnvironmentDto; editable: boolean }) {
  const { project } = useProject();
  const base = `/api/projects/${encodeURIComponent(project.id)}/environments/${encodeURIComponent(env.id)}/credentials`;
  const [list, setList] = useState<CredentialDto[] | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setList((await api<{ credentials: CredentialDto[] }>('GET', base)).credentials);
    } catch (e) {
      setError(errorText(e));
    }
  }, [base]);
  useEffect(() => {
    void load();
  }, [load, env.updatedAt, env.credentialNames.join(',')]);

  const put = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api('PUT', `${base}/${encodeURIComponent(name.trim())}`, { value });
      setName('');
      setValue('');
      await load();
    } catch (err) {
      setError(issuesText(err));
    }
  };
  const remove = async (c: CredentialDto) => {
    if (!window.confirm(`테스트 계정 "${c.name}" 을(를) 삭제할까요?`)) return;
    try {
      await api('DELETE', `${base}/${encodeURIComponent(c.name)}`);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  };
  const nameOk = CREDENTIAL_NAME.test(name.trim());
  return (
    <div className="credentials" data-testid="credentials">
      <div className="small">
        <b>테스트 계정</b> <span className="muted">— 값은 저장 후 누구도 다시 볼 수 없습니다(이름·마지막 변경만). 스크립트에서 {'${secrets.이름}'} 으로 씁니다.</span>
      </div>
      {list && list.length > 0 && (
        <table className="compact">
          <tbody>
            {list.map((c) => (
              <tr key={c.name} data-testid="credential-row" data-name={c.name}>
                <td>
                  <code>🔒{c.name}</code>
                </td>
                <td className="small muted">
                  {fmtTime(c.updatedAt)} {c.updatedBy?.name ?? ''}
                </td>
                <td>
                  {editable && (
                    <div className="row actions">
                      <Button size="sm" icon={KeyRound} onClick={() => setName(c.name)}>
                        값 바꾸기
                      </Button>
                      <Button size="sm" variant="danger" icon={Trash} onClick={() => void remove(c)}>
                        삭제
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {list && list.length === 0 && <p className="muted small">없음</p>}
      {editable && (
        <form className="inline" onSubmit={put} data-testid="credential-form">
          <TextField
            label="이름"
            name="credential-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="USER_EMAIL"
            autoComplete="off"
            error={name.trim() && !nameOk ? '이름은 영문·숫자·_ (첫 글자는 숫자 아님)' : undefined}
          />
          <TextField label="값" name="credential-value" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
          <Button type="submit" icon={Save} disabled={!nameOk || !value}>
            저장
          </Button>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

// ── Notifications · rules · daily cap ──────────────────────────────────────────

const NOTIFY_KO: [keyof ProjectDto['notify'], string][] = [
  ['skipped', '건너뜀'],
  ['aborted', '중단'],
  ['passed', '통과'],
  ['flaky', '통과 · 불안정'],
];

function Notifications() {
  const { project, can } = useProject();
  const ro = !can('project.update');
  // The server includes the URL only for callers who may change settings (it is a secret).
  const showsUrl = 'teamsWebhookUrl' in project;
  const [url, setUrl] = useState(project.teamsWebhookUrl ?? '');
  const { save, view } = useSaver();
  useEffect(() => setUrl(project.teamsWebhookUrl ?? ''), [project.teamsWebhookUrl]);
  return (
    <Section title="알림" testId="settings-notify">
      <p className="muted small">예약 실행의 실패·오류·시간 초과와 회복은 항상 알립니다(같은 대상·환경의 연속 실패는 처음 1번). 아래는 기본 꺼짐 알림입니다.</p>
      {showsUrl ? (
        <form
          className="inline"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ teamsWebhookUrl: url.trim() || null });
          }}
          data-testid="webhook-form"
        >
          <TextField
            label="Teams 워크플로 webhook 주소"
            help="비밀값 — 편집자 이상에게만 보입니다"
            className="grow"
            name="webhook"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://…"
            disabled={ro}
          />
          {!ro && (
            <Button type="submit" icon={Save}>
              저장
            </Button>
          )}
        </form>
      ) : (
        <p data-testid="webhook-status">Teams 알림: {project.teamsWebhookConfigured ? '설정됨' : '설정 안 됨'}</p>
      )}
      <div className="row toggles" data-testid="notify-toggles">
        {NOTIFY_KO.map(([k, label]) => (
          <Switch key={k} label={label} checked={project.notify[k]} disabled={ro} onChange={(e) => void save({ notify: { [k]: e.target.checked } })} />
        ))}
      </div>
      {view}
    </Section>
  );
}

function Rules() {
  const { project, can } = useProject();
  const ro = !can('project.update');
  const [rules, setRules] = useState(project.testRules);
  const [cap, setCap] = useState(String(project.dailyRunCap));
  const { save, view } = useSaver();
  useEffect(() => {
    setRules(project.testRules);
    setCap(String(project.dailyRunCap));
  }, [project.testRules, project.dailyRunCap]);
  const capN = Number(cap);
  const capOk = Number.isInteger(capN) && capN >= 1 && capN <= DAILY_RUN_CAP_MAX;
  return (
    <Section title="테스트 규칙 · 하루 실행 상한" testId="settings-rules">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save({ testRules: rules, dailyRunCap: capN });
        }}
      >
        <fieldset disabled={ro}>
          <TextArea
            label="테스트 규칙"
            help="실사용 부작용 주의 — 전용 계정·게시 금지 채널·정리 방법 등, 실행 화면·MCP 결과에 함께 보임"
            rows={4}
            maxLength={2000}
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            name="test-rules"
          />
          <div className="inline">
            <TextField label={`하루 실행 상한 (1~${DAILY_RUN_CAP_MAX}, Asia/Seoul 하루의 스크립트 실행 수)`} inputClassName="num" value={cap} onChange={(e) => setCap(e.target.value)} name="daily-cap" />
            {project.dailyRunUsage && (
              <span className="muted small">
                오늘 {project.dailyRunUsage.used} / {project.dailyRunUsage.cap}
              </span>
            )}
            {!ro && (
              <Button type="submit" icon={Save} disabled={!capOk}>
                저장
              </Button>
            )}
          </div>
        </fieldset>
      </form>
      {view}
    </Section>
  );
}

function DeleteProject() {
  const { project } = useProject();
  const [confirmName, setConfirmName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('DELETE', `/api/projects/${encodeURIComponent(project.id)}`, { confirmName });
      navigate('/?scope=trash', { force: true });
    } catch (err) {
      setError(errorText(err));
    }
  };
  return (
    <Section title="프로젝트 삭제" testId="settings-delete">
      <p className="muted small">휴지통으로 보내고 예약을 모두 끕니다. 30일 안에는 소유자가 복원할 수 있고, 지나면 스크립트·이력·결과 파일·테스트 계정이 영구 삭제됩니다.</p>
      <form className="inline" onSubmit={submit}>
        <TextField label="확인을 위해 프로젝트 이름을 입력하세요" name="confirm-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={project.name} />
        <Button type="submit" variant="danger" icon={Trash} disabled={confirmName !== project.name}>
          삭제
        </Button>
      </form>
      {error && <p className="error">{error}</p>}
    </Section>
  );
}
