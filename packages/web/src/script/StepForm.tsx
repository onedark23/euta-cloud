// Action forms for the step editor (SPEC 스크립트-보기-편집 "동작별 폼"): target picker (kind +
// value), input values (plain / secret name / variable / environment variable), expect
// conditions, measure kinds, common options, step name; and the script header form.
// Forms only touch the fields they know — anything else in the step object is kept.
// Copied from euta-app src/renderer/src/tabs/StepForm.tsx (keep in step — see ADR-029); web changes:
// the "AI에게" hint is not shown (no AI request on the web) and `type="button"` on buttons.
import { useState, type ReactNode } from 'react';
import { ROLE_NAMES } from '@euta/core/describe';
import { Crosshair, Minus, Plus } from 'lucide-react';
import { Button } from '../ui';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'string' ? v : String(v));

/** Drop keys whose value is undefined or '' (absent = default). */
function prune(o: Obj): Obj {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ''));
}

/** Duration/size text: digits only → number (ms / bytes), otherwise the text ("2s"); empty → undefined. */
function durOf(s: string): number | string | undefined {
  const t = s.trim();
  if (!t) return undefined;
  return /^\d+$/.test(t) ? Number(t) : t;
}

function intOf(s: string): number | undefined {
  const t = s.trim();
  if (!t || !/^-?\d+$/.test(t)) return undefined;
  return Number(t);
}

export interface FormContext {
  secretNames: string[];
  varNames: string[];
}

// ---- target picker -----------------------------------------------------------------------

const TARGET_KINDS: { kind: string; label: string }[] = [
  { kind: 'role', label: '역할 + 이름 (버튼·링크 등)' },
  { kind: 'label', label: '라벨 (입력란)' },
  { kind: 'placeholder', label: '안내 문구 (placeholder)' },
  { kind: 'text', label: '보이는 글자' },
  { kind: 'testId', label: 'testId' },
  { kind: 'css', label: 'CSS (불안정)' },
];

function targetKind(t: unknown): string {
  if (typeof t === 'string') return 'css';
  if (!isObj(t)) return 'role';
  return TARGET_KINDS.find((k) => t[k.kind] !== undefined)?.kind ?? 'role';
}

export function TargetPicker({ value, onChange, testId = 'f-target', optional }: { value: unknown; onChange: (v: unknown) => void; testId?: string; optional?: boolean }) {
  const t: Obj = typeof value === 'string' ? { css: value } : isObj(value) ? value : {};
  const kind = targetKind(value);
  const set = (patch: Obj) => onChange(prune({ ...t, ...patch }));
  if (optional && value === undefined) {
    return (
      <Button size="sm" icon={Crosshair} onClick={() => onChange({ role: 'button', name: '' })} data-testid={`${testId}-add`}>
        대상 지정
      </Button>
    );
  }
  return (
    <span className="target-picker inline" data-testid={testId}>
      <select
        value={kind}
        onChange={(e) => {
          const k = e.target.value;
          const keep = prune({ nth: t.nth, exact: t.exact });
          onChange(k === 'role' ? { role: 'button', name: '', ...keep } : { [k]: '', ...keep });
        }}
        data-testid={`${testId}-kind`}
      >
        {TARGET_KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      {kind === 'role' ? (
        <>
          <select value={str(t.role)} onChange={(e) => set({ role: e.target.value })} data-testid={`${testId}-role`}>
            {!(str(t.role) in ROLE_NAMES) && <option value={str(t.role)}>{str(t.role) || '(역할)'}</option>}
            {Object.entries(ROLE_NAMES).map(([r, n]) => (
              <option key={r} value={r}>
                {n} ({r})
              </option>
            ))}
          </select>
          <input placeholder="이름 (예: 로그인)" value={str(t.name)} onChange={(e) => onChange({ ...t, name: e.target.value })} data-testid={`${testId}-name`} />
        </>
      ) : (
        <input placeholder="값" value={str(t[kind])} onChange={(e) => onChange({ ...prune({ ...t, [kind]: undefined }), [kind]: e.target.value })} data-testid={`${testId}-value`} />
      )}
      <label className="small muted" title="여러 개가 맞을 때 몇 번째 (1부터, -1 = 마지막)">
        번째
        <input className="num" value={t.nth === undefined ? '' : t.nth === -1 ? '-1' : String(Number(t.nth) + 1)} onChange={(e) => {
          const n = intOf(e.target.value);
          set({ nth: n === undefined ? undefined : n === -1 ? -1 : Math.max(0, n - 1) });
        }} data-testid={`${testId}-nth`} />
      </label>
      {kind !== 'testId' && kind !== 'css' && (
        <label className="small muted">
          <input type="checkbox" checked={t.exact === true} onChange={(e) => set({ exact: e.target.checked ? true : undefined })} /> 정확히
        </label>
      )}
      {optional && (
        <Button size="sm" variant="danger" icon={Minus} onClick={() => onChange(undefined)}>
          대상 빼기
        </Button>
      )}
    </span>
  );
}

// ---- value input (plain / secret / var / env) -----------------------------------------------

const FULL_REF = /^\$\{\s*(secrets|vars|env)\.([\w.-]+)\s*\}$/;

export function ValueInput({ value, onChange, ctx, testId = 'f-value' }: { value: unknown; onChange: (v: string) => void; ctx: FormContext; testId?: string }) {
  const s = str(value);
  const m = FULL_REF.exec(s);
  const mode = m ? m[1]! : 'plain';
  const name = m?.[2] ?? '';
  const [custom, setCustom] = useState(false);
  const setMode = (k: string) => {
    if (k === 'plain') onChange('');
    else if (k === 'secrets') onChange(`\${secrets.${ctx.secretNames[0] ?? 'NAME'}}`);
    else if (k === 'vars') onChange(`\${vars.${ctx.varNames[0] ?? 'name'}}`);
    else onChange('${env.NAME}');
  };
  return (
    <span className="inline" data-testid={testId}>
      <select value={mode} onChange={(e) => setMode(e.target.value)} data-testid={`${testId}-mode`}>
        <option value="plain">일반 값</option>
        <option value="secrets">🔒 secret</option>
        <option value="vars">변수 {'{ }'}</option>
        <option value="env">환경 변수 [ ]</option>
      </select>
      {mode === 'plain' && <input className="grow" value={s} onChange={(e) => onChange(e.target.value)} data-testid={`${testId}-text`} />}
      {mode === 'secrets' &&
        (custom || (name && !ctx.secretNames.includes(name)) ? (
          <input placeholder="새 secret 이름" value={name} onChange={(e) => onChange(`\${secrets.${e.target.value.replace(/[^\w.-]/g, '')}}`)} data-testid={`${testId}-secret-new`} />
        ) : (
          <select
            value={name}
            onChange={(e) => (e.target.value === '__new' ? setCustom(true) : onChange(`\${secrets.${e.target.value}}`))}
            data-testid={`${testId}-secret`}
          >
            {ctx.secretNames.map((n) => (
              <option key={n} value={n}>
                🔒{n}
              </option>
            ))}
            <option value="__new">새 이름…</option>
          </select>
        ))}
      {mode === 'vars' && (
        <select value={name} onChange={(e) => onChange(`\${vars.${e.target.value}}`)} data-testid={`${testId}-var`}>
          {!ctx.varNames.includes(name) && <option value={name}>{name || '(변수)'}</option>}
          {ctx.varNames.map((n) => (
            <option key={n} value={n}>
              {`{${n}}`}
            </option>
          ))}
        </select>
      )}
      {mode === 'env' && <input value={name} onChange={(e) => onChange(`\${env.${e.target.value.replace(/[^\w.-]/g, '')}}`)} data-testid={`${testId}-env`} />}
      {mode === 'secrets' && <span className="muted small">값은 프로젝트 설정 → 환경에서 등록</span>}
    </span>
  );
}

// ---- expect conditions ---------------------------------------------------------------------

const EXPECT_KINDS: { kind: string; label: string; make: () => unknown }[] = [
  { kind: 'url', label: '주소', make: () => '/' },
  { kind: 'title', label: '페이지 제목', make: () => '' },
  { kind: 'visible', label: '보임', make: () => ({ text: '' }) },
  { kind: 'hidden', label: '안 보임', make: () => ({ text: '' }) },
  { kind: 'text', label: '글자', make: () => ({ target: { text: '' }, contains: '' }) },
  { kind: 'count', label: '개수', make: () => ({ target: { role: 'row' }, min: 1 }) },
  { kind: 'console', label: '콘솔 오류', make: () => ({ errors: 0 }) },
  { kind: 'network', label: '네트워크 실패', make: () => ({ failed: 0 }) },
  { kind: 'metric', label: '지표 (LCP 등)', make: () => ({ name: 'LCP', max: '2.5s' }) },
  { kind: 'responseTime', label: '응답 시간', make: () => ({ max: '3s' }) },
];

function ExpectCondition({ kind, value, onChange, ctx, i }: { kind: string; value: unknown; onChange: (v: unknown) => void; ctx: FormContext; i: number }) {
  const o = isObj(value) ? value : {};
  const tid = `f-expect-${i}`;
  switch (kind) {
    case 'url':
    case 'title':
      return <input className="grow" value={str(value)} onChange={(e) => onChange(e.target.value)} placeholder="포함할 글자 또는 /정규식/" data-testid={`${tid}-text`} />;
    case 'visible':
    case 'hidden':
      return <TargetPicker value={value} onChange={onChange} testId={`${tid}-target`} />;
    case 'text': {
      const mode = o.equals !== undefined ? 'equals' : o.matches !== undefined ? 'matches' : 'contains';
      return (
        <span className="inline">
          <TargetPicker value={o.target} onChange={(t) => onChange({ ...o, target: t })} testId={`${tid}-target`} />
          <select value={mode} onChange={(e) => onChange({ target: o.target, [e.target.value]: str(o[mode]) })} data-testid={`${tid}-mode`}>
            <option value="contains">포함</option>
            <option value="equals">같음</option>
            <option value="matches">정규식</option>
          </select>
          <ValueInput value={o[mode]} onChange={(v) => onChange({ target: o.target, [mode]: v })} ctx={ctx} testId={`${tid}-value`} />
        </span>
      );
    }
    case 'count':
      return (
        <span className="inline">
          <TargetPicker value={o.target} onChange={(t) => onChange({ ...o, target: t })} testId={`${tid}-target`} />
          {(['equals', 'min', 'max'] as const).map((k) => (
            <label key={k} className="small">
              {k === 'equals' ? '=' : k === 'min' ? '이상' : '이하'}
              <input className="num" value={str(o[k])} onChange={(e) => onChange(prune({ ...o, [k]: intOf(e.target.value) }))} />
            </label>
          ))}
        </span>
      );
    case 'console':
      return (
        <span className="inline">
          {(['errors', 'warnings'] as const).map((k) => (
            <label key={k} className="small">
              {k === 'errors' ? '오류 수' : '경고 수'}
              <input className="num" value={str(o[k])} onChange={(e) => onChange(prune({ ...o, [k]: intOf(e.target.value) }))} />
            </label>
          ))}
        </span>
      );
    case 'network':
      return (
        <span className="inline">
          <label className="small">
            실패 요청 수 <input className="num" value={str(o.failed)} onChange={(e) => onChange(prune({ ...o, failed: intOf(e.target.value) }))} />
          </label>
          <label className="small">
            느린 기준 <input className="num" value={str(o.slowerThan)} onChange={(e) => onChange(prune({ ...o, slowerThan: durOf(e.target.value) }))} placeholder="2s" />
          </label>
          <label className="small">
            최대 개수 <input className="num" value={str(o.maxCount)} onChange={(e) => onChange(prune({ ...o, maxCount: intOf(e.target.value) }))} />
          </label>
        </span>
      );
    case 'metric':
      return (
        <span className="inline">
          <select value={str(o.name)} onChange={(e) => onChange({ ...o, name: e.target.value })}>
            {['LCP', 'CLS', 'INP', 'FCP', 'TTFB', 'DOMContentLoaded', 'Load', 'responseTime'].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
          <label className="small">
            최소 <input className="num" value={str(o.min)} onChange={(e) => onChange(prune({ ...o, min: durOf(e.target.value) }))} />
          </label>
          <label className="small">
            최대 <input className="num" value={str(o.max)} onChange={(e) => onChange(prune({ ...o, max: durOf(e.target.value) }))} />
          </label>
        </span>
      );
    case 'responseTime':
      return (
        <label className="small">
          최대 <input className="num" value={str(o.max)} onChange={(e) => onChange({ max: durOf(e.target.value) ?? '' })} />
        </label>
      );
    default:
      return <span className="muted small">이 조건은 폼으로 고칠 수 없습니다</span>;
  }
}

function ExpectForm({ value, onChange, ctx }: { value: unknown; onChange: (v: Obj) => void; ctx: FormContext }) {
  const o = isObj(value) ? value : {};
  const used = Object.keys(o);
  return (
    <div className="expect-form" data-testid="f-expect">
      {used.map((k, i) => (
        <div key={k} className="inline cond-row" data-testid="f-expect-cond" data-kind={k}>
          <span className="cond-label">{EXPECT_KINDS.find((x) => x.kind === k)?.label ?? k}</span>
          <ExpectCondition kind={k} value={o[k]} onChange={(v) => onChange({ ...o, [k]: v })} ctx={ctx} i={i} />
          <Button size="sm" variant="danger" icon={Minus} onClick={() => onChange(prune({ ...o, [k]: undefined }))} data-testid="f-expect-remove">
            빼기
          </Button>
        </div>
      ))}
      <select
        value=""
        onChange={(e) => {
          const k = EXPECT_KINDS.find((x) => x.kind === e.target.value);
          if (k) onChange({ ...o, [k.kind]: k.make() });
        }}
        data-testid="f-expect-add"
      >
        <option value="">+ 조건 추가</option>
        {EXPECT_KINDS.filter((k) => !used.includes(k.kind)).map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---- per-action forms ------------------------------------------------------------------------

const MEASURES: { kind: string; label: string }[] = [
  { kind: 'web-vitals', label: 'Web Vitals' },
  { kind: 'timing', label: '시간' },
  { kind: 'screenshot', label: '스크린샷' },
  { kind: 'visual', label: '시각 비교' },
];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="f-field">
      <span className="f-label">{label}</span>
      <span className="f-input">{children}</span>
    </div>
  );
}

function ActionFields({ action, args, set, ctx }: { action: string; args: unknown; set: (v: unknown) => void; ctx: FormContext }) {
  const o: Obj = isObj(args) ? args : {};
  const patch = (p: Obj) => set(prune({ ...o, ...p }));
  const target = (key = 'target', label = '대상', optional = false) => (
    <Field label={label}>
      <TargetPicker value={o[key]} onChange={(t) => set(prune({ ...o, [key]: t }))} testId={`f-${key}`} optional={optional} />
    </Field>
  );
  switch (action) {
    case 'goto':
      return (
        <Field label="주소">
          <input className="grow" value={str(isObj(args) ? args.url : args)} onChange={(e) => set(e.target.value)} placeholder="/login 또는 https://…" data-testid="f-url" />
        </Field>
      );
    case 'click':
      return (
        <>
          {target()}
          <Field label="버튼 · 횟수">
            <select value={str(o.button) || 'left'} onChange={(e) => patch({ button: e.target.value === 'left' ? undefined : e.target.value })}>
              <option value="left">왼쪽</option>
              <option value="right">오른쪽</option>
              <option value="middle">가운데</option>
            </select>
            <input className="num" value={str(o.clickCount)} onChange={(e) => patch({ clickCount: intOf(e.target.value) })} placeholder="1" />
          </Field>
        </>
      );
    case 'dblclick':
    case 'hover':
    case 'tap':
    case 'check':
    case 'uncheck':
      return target();
    case 'fill':
      return (
        <>
          {target()}
          <Field label="입력값">
            <ValueInput value={o.value} onChange={(v) => set({ ...o, value: v })} ctx={ctx} />
          </Field>
        </>
      );
    case 'type':
      return (
        <>
          {target()}
          <Field label="입력값">
            <ValueInput value={o.text} onChange={(v) => set({ ...o, text: v })} ctx={ctx} />
          </Field>
          <Field label="글자 간격">
            <input className="num" value={str(o.delay)} onChange={(e) => patch({ delay: durOf(e.target.value) })} placeholder="50ms" />
          </Field>
        </>
      );
    case 'press':
      return (
        <>
          <Field label="키">
            <input value={str(o.key)} onChange={(e) => set({ ...o, key: e.target.value })} placeholder="Enter, Tab, Control+A" data-testid="f-key" />
          </Field>
          {target('target', '대상 (선택)', true)}
        </>
      );
    case 'select': {
      const mode = o.label !== undefined ? 'label' : 'value';
      const cur = o[mode];
      return (
        <>
          {target()}
          <Field label="고를 항목">
            <select value={mode} onChange={(e) => set({ target: o.target, [e.target.value]: cur ?? '' })}>
              <option value="label">보이는 이름</option>
              <option value="value">값(value)</option>
            </select>
            <input value={Array.isArray(cur) ? cur.join(', ') : str(cur)} onChange={(e) => {
              const parts = e.target.value.split(',').map((x) => x.trim());
              set({ target: o.target, [mode]: parts.length > 1 ? parts : e.target.value });
            }} placeholder="여러 개는 쉼표로" data-testid="f-select" />
          </Field>
        </>
      );
    }
    case 'upload':
      return (
        <>
          {target()}
          <Field label="파일">
            <input className="grow" value={Array.isArray(o.files) ? o.files.join(', ') : str(o.files)} onChange={(e) => {
              const parts = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
              set({ ...o, files: parts.length > 1 ? parts : (parts[0] ?? '') });
            }} placeholder="fixtures/a.pdf (스크립트 폴더 기준)" />
          </Field>
        </>
      );
    case 'scroll': {
      const mode = o.target !== undefined ? 'target' : o.to !== undefined ? String(o.to) : o.by !== undefined ? 'by' : 'bottom';
      return (
        <Field label="스크롤">
          <select value={mode} onChange={(e) => {
            const v = e.target.value;
            set(v === 'target' ? { target: { text: '' } } : v === 'by' ? { by: { y: 300 } } : { to: v });
          }}>
            <option value="bottom">맨 아래로</option>
            <option value="top">맨 위로</option>
            <option value="target">대상까지</option>
            <option value="by">만큼</option>
          </select>
          {mode === 'target' && <TargetPicker value={o.target} onChange={(t) => set({ target: t })} />}
          {mode === 'by' && isObj(o.by) && (
            <>
              <input className="num" value={str(o.by.x)} onChange={(e) => set({ by: prune({ ...(o.by as Obj), x: intOf(e.target.value) }) })} placeholder="가로" />
              <input className="num" value={str(o.by.y)} onChange={(e) => set({ by: prune({ ...(o.by as Obj), y: intOf(e.target.value) }) })} placeholder="세로" />
            </>
          )}
        </Field>
      );
    }
    case 'drag':
      return (
        <>
          {target('from', '끌 대상')}
          {target('to', '놓을 곳')}
        </>
      );
    case 'wait': {
      const f = o.for;
      const mode = o.ms !== undefined ? 'ms' : f === 'network-idle' ? 'network-idle' : isObj(f) ? (Object.keys(f)[0] ?? 'ms') : 'ms';
      return (
        <Field label="기다리기">
          <select value={mode} onChange={(e) => {
            const v = e.target.value;
            set(v === 'ms' ? { ms: 1000 } : v === 'network-idle' ? { for: 'network-idle' } : v === 'url' ? { for: { url: '/' } } : { for: { [v]: { text: '' } } });
          }} data-testid="f-wait-mode">
            <option value="ms">시간</option>
            <option value="network-idle">네트워크 잠잠</option>
            <option value="visible">대상이 보일 때까지</option>
            <option value="hidden">대상이 사라질 때까지</option>
            <option value="url">주소가 바뀔 때까지</option>
          </select>
          {mode === 'ms' && <input className="num" value={str(o.ms)} onChange={(e) => set({ ms: durOf(e.target.value) ?? '' })} placeholder="1000 또는 2s" data-testid="f-wait-ms" />}
          {(mode === 'visible' || mode === 'hidden') && isObj(f) && <TargetPicker value={f[mode]} onChange={(t) => set({ for: { [mode]: t } })} />}
          {mode === 'url' && isObj(f) && <input value={str(f.url)} onChange={(e) => set({ for: { url: e.target.value } })} />}
        </Field>
      );
    }
    case 'expect':
      return <ExpectForm value={args} onChange={set} ctx={ctx} />;
    case 'measure': {
      const list = (Array.isArray(args) ? args : [args]).map(str);
      return (
        <Field label="측정 항목">
          {MEASURES.map((m) => (
            <label key={m.kind} className="small">
              <input
                type="checkbox"
                checked={list.includes(m.kind)}
                onChange={(e) => {
                  const next = e.target.checked ? [...list, m.kind] : list.filter((x) => x !== m.kind);
                  set(next.length === 1 ? next[0] : next);
                }}
                data-testid={`f-measure-${m.kind}`}
              />{' '}
              {m.label}
            </label>
          ))}
        </Field>
      );
    }
    case 'expectDownload': {
      const trig = isObj(o.trigger) ? o.trigger : undefined;
      const trigClick = trig && isObj(trig.click) ? trig.click : undefined;
      return (
        <>
          <Field label="누를 것 (클릭)">
            {trig && !trigClick ? (
              <span className="muted small">클릭이 아닌 동작 — 폼으로 고칠 수 없습니다</span>
            ) : (
              <TargetPicker value={trigClick?.target} onChange={(t) => set({ ...o, trigger: t === undefined ? undefined : { ...trig, click: { ...(trigClick ?? {}), target: t } } })} testId="f-trigger" optional />
            )}
          </Field>
          <Field label="파일 종류 · 이름">
            <input className="num" value={str(o.type)} onChange={(e) => patch({ type: e.target.value })} placeholder="pdf" />
            <input value={str(o.name)} onChange={(e) => patch({ name: e.target.value })} placeholder="*.pdf" />
          </Field>
          <Field label="크기">
            <input className="num" value={str(o.minSize)} onChange={(e) => patch({ minSize: durOf(e.target.value) })} placeholder="1kb 이상" />
            <input className="num" value={str(o.maxSize)} onChange={(e) => patch({ maxSize: durOf(e.target.value) })} placeholder="이하" />
          </Field>
          <Field label="포함할 글자">
            <input className="grow" value={Array.isArray(o.contains) ? o.contains.join(', ') : str(o.contains)} onChange={(e) => {
              const parts = e.target.value.split(',').map((x) => x.trim()).filter(Boolean);
              patch({ contains: parts.length > 1 ? parts : parts[0] });
            }} placeholder="쉼표로 여러 개" />
          </Field>
          <Field label="CSV 최소 행">
            <input className="num" value={isObj(o.csv) ? str(o.csv.minRows) : ''} onChange={(e) => {
              const n = intOf(e.target.value);
              patch({ csv: n === undefined ? undefined : { minRows: n } });
            }} />
          </Field>
        </>
      );
    }
    case 'visual':
      return (
        <>
          <Field label="기준 이름">
            <input value={str(o.name)} onChange={(e) => set({ ...o, name: e.target.value })} data-testid="f-visual-name" />
          </Field>
          {target('target', '영역 (선택)', true)}
          <Field label="허용 차이 · 전체 페이지">
            <input className="num" value={str(o.threshold)} onChange={(e) => patch({ threshold: e.target.value.trim() ? Number(e.target.value) : undefined })} placeholder="0.01" />
            <label className="small">
              <input type="checkbox" checked={o.fullPage === true} onChange={(e) => patch({ fullPage: e.target.checked || undefined })} /> 전체 페이지
            </label>
          </Field>
        </>
      );
    case 'group':
      return (
        <Field label="묶음 이름">
          <input value={str(o.name)} onChange={(e) => set({ ...o, name: e.target.value })} data-testid="f-group-name" />
        </Field>
      );
    case 'ai':
      return (
        <Field label="AI 지시 (예약 기능)">
          <input className="grow" value={str(o.instruction)} onChange={(e) => set({ instruction: e.target.value })} />
        </Field>
      );
    default:
      return <p className="muted small">이 단계는 폼으로 고칠 수 없습니다. 로컬 앱에서 고치세요.</p>;
  }
}

const ACTIONS = ['goto', 'click', 'dblclick', 'hover', 'tap', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'upload', 'scroll', 'drag', 'wait', 'expect', 'measure', 'expectDownload', 'visual', 'group', 'ai'];

/** Form for one step: action fields + common options + step name. */
export function StepForm({ step, onChange, ctx }: { step: Obj; onChange: (s: Obj) => void; ctx: FormContext }) {
  const action = Object.keys(step).find((k) => ACTIONS.includes(k)) ?? '';
  const common = (k: string, v: unknown) => onChange(prune({ ...step, [k]: v }));
  return (
    <div className="step-form" data-testid="step-form" data-action={action}>
      <ActionFields action={action} args={step[action]} set={(v) => onChange({ ...step, [action]: v })} ctx={ctx} />
      <div className="f-common">
        <Field label="단계 이름">
          <input value={str(step.name)} onChange={(e) => common('name', e.target.value || undefined)} placeholder="(선택) 굵은 제목으로 보임" data-testid="f-name" />
        </Field>
        {action !== 'group' && (
          <Field label="공통 옵션">
            <label className="small">
              <input type="checkbox" checked={step.optional === true} onChange={(e) => common('optional', e.target.checked || undefined)} data-testid="f-optional" /> 선택 단계
            </label>
            <label className="small">
              대기 <input className="num" value={str(step.timeout)} onChange={(e) => common('timeout', durOf(e.target.value))} placeholder="10s" data-testid="f-timeout" />
            </label>
            <select value={str(step.input)} onChange={(e) => common('input', e.target.value || undefined)} title="입력 방식">
              <option value="">입력: 기본</option>
              <option value="browser">브라우저 입력</option>
              <option value="os">OS 입력</option>
            </select>
            <select value={str(step.settle)} onChange={(e) => common('settle', e.target.value || undefined)} title="화면 안정 조건">
              <option value="">안정: 기본</option>
              <option value="network-idle">네트워크 잠잠</option>
              <option value="dom-stable">화면 변화 멈춤</option>
              <option value="none">기다리지 않음</option>
            </select>
            <select value={step.screenshot === true ? 'on' : step.screenshot === false ? 'off' : ''} onChange={(e) => common('screenshot', e.target.value === 'on' ? true : e.target.value === 'off' ? false : undefined)} title="스크린샷">
              <option value="">스크린샷: 기본</option>
              <option value="on">찍기</option>
              <option value="off">안 찍기</option>
            </select>
          </Field>
        )}
      </div>
    </div>
  );
}

// ---- script header ------------------------------------------------------------------------------

export function HeaderForm({ header, onChange }: { header: Obj; onChange: (h: Obj) => void }) {
  const set = (k: string, v: unknown) => onChange(prune({ ...header, [k]: v }));
  const sub = (k: string): Obj => (isObj(header[k]) ? (header[k] as Obj) : {});
  const setSub = (k: string, kk: string, v: unknown) => {
    const next = prune({ ...sub(k), [kk]: v });
    set(k, Object.keys(next).length ? next : undefined);
  };
  const vars = sub('vars');
  const [newVar, setNewVar] = useState('');
  const browser = sub('browser');
  const viewport = isObj(browser.viewport) ? browser.viewport : undefined;
  return (
    <div className="header-form" data-testid="header-form">
      <Field label="이름">
        <input className="grow" value={str(header.name)} onChange={(e) => onChange({ ...header, name: e.target.value })} data-testid="h-name" />
      </Field>
      <Field label="설명">
        <input className="grow" value={str(header.description)} onChange={(e) => set('description', e.target.value)} data-testid="h-description" />
      </Field>
      <Field label="대상 주소">
        <input className="grow" value={str(sub('target').baseUrl)} onChange={(e) => setSub('target', 'baseUrl', e.target.value)} placeholder="${env.BASE_URL}" data-testid="h-baseurl" />
      </Field>
      <Field label="기본값">
        <label className="small">
          대기 <input className="num" value={str(sub('defaults').timeout)} onChange={(e) => setSub('defaults', 'timeout', durOf(e.target.value))} placeholder="10s" data-testid="h-timeout" />
        </label>
        <select value={str(sub('defaults').settle)} onChange={(e) => setSub('defaults', 'settle', e.target.value || undefined)} title="화면 안정 조건">
          <option value="">안정: 기본</option>
          <option value="network-idle">네트워크 잠잠</option>
          <option value="dom-stable">화면 변화 멈춤</option>
          <option value="none">기다리지 않음</option>
        </select>
        <select value={str(sub('defaults').input)} onChange={(e) => setSub('defaults', 'input', e.target.value || undefined)} title="입력 방식">
          <option value="">입력: 브라우저</option>
          <option value="os">OS 입력</option>
        </select>
      </Field>
      <Field label="녹화">
        {(['video', 'trace', 'har', 'console'] as const).map((k) => (
          <label key={k} className="small">
            <input type="checkbox" checked={sub('record')[k] !== false} onChange={(e) => setSub('record', k, e.target.checked ? undefined : false)} /> {k}
          </label>
        ))}
        <select value={str(sub('record').screenshots)} onChange={(e) => setSub('record', 'screenshots', e.target.value || undefined)}>
          <option value="">스크린샷: 단계마다</option>
          <option value="on-failure">실패 시만</option>
          <option value="none">안 찍음</option>
        </select>
      </Field>
      <Field label="브라우저">
        <select value={str(browser.engine)} onChange={(e) => setSub('browser', 'engine', e.target.value || undefined)}>
          <option value="">엔진: 프로젝트 기본</option>
          <option value="chromium">chromium</option>
          <option value="firefox">firefox</option>
          <option value="webkit">webkit</option>
        </select>
        <input value={str(browser.device)} onChange={(e) => setSub('browser', 'device', e.target.value || undefined)} placeholder="기기 (예: iPhone 15)" />
        <input className="num" value={str(viewport?.width)} onChange={(e) => {
          const w = intOf(e.target.value);
          setSub('browser', 'viewport', w === undefined ? undefined : { width: w, height: Number(viewport?.height ?? 800) });
        }} placeholder="폭" />
        <input className="num" value={str(viewport?.height)} onChange={(e) => {
          const h = intOf(e.target.value);
          setSub('browser', 'viewport', h === undefined ? undefined : { width: Number(viewport?.width ?? 1280), height: h });
        }} placeholder="높이" />
        <input className="num" value={str(browser.locale)} onChange={(e) => setSub('browser', 'locale', e.target.value || undefined)} placeholder="ko-KR" />
        <label className="small">
          <input type="checkbox" checked={browser.hasTouch === true} onChange={(e) => setSub('browser', 'hasTouch', e.target.checked || undefined)} /> 터치
        </label>
      </Field>
      <Field label="변수">
        <span className="vars-list">
          {Object.entries(vars).map(([k, v]) => (
            <span key={k} className="inline" data-testid="h-var" data-name={k}>
              <code>{`{${k}}`}</code>
              <input value={str(v)} onChange={(e) => setSub('vars', k, e.target.value)} />
              <Button size="sm" variant="danger" icon={Minus} onClick={() => setSub('vars', k, undefined)}>
                빼기
              </Button>
            </span>
          ))}
          <span className="inline">
            <input value={newVar} onChange={(e) => setNewVar(e.target.value.replace(/[^\w]/g, ''))} placeholder="새 변수 이름" data-testid="h-var-new" />
            <Button size="sm" icon={Plus} disabled={!newVar || newVar in vars} onClick={() => (setSub('vars', newVar, ''), setNewVar(''))} data-testid="h-var-add">
              추가
            </Button>
          </span>
        </span>
      </Field>
    </div>
  );
}
