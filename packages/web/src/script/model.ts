// Step-level editor model (SPEC 스크립트-보기-편집 "단계 단위 편집"). Copied from euta-app
// src/shared/script-model.ts (keep in step — see ADR-029). Pure functions over a plain model; every
// step remembers its source path in the original YAML so the server can write the edit back with
// comments and order kept (`POST …/scripts/check` → engine rewriteScript). Operations return a new
// model (React state).

/** Engine `ScriptEdit` (what `POST …/scripts/check` takes as `edit`). */
export interface ScriptEditPayload {
  header: Record<string, unknown>;
  steps: StepEditPayload[];
}
export interface StepEditPayload {
  src?: (string | number)[];
  step: Record<string, unknown>;
  children?: StepEditPayload[];
}

export interface EStep {
  /** UI identity (stable while editing). */
  id: string;
  /** Source path in the original text (absent = new step). */
  src?: (string | number)[];
  /** The step object; for groups `group.steps` is replaced by `children`. */
  step: Record<string, unknown>;
  children?: EStep[];
}

export interface EModel {
  /** Top-level keys except `steps`. */
  header: Record<string, unknown>;
  steps: EStep[];
}

/** Position of a step: [i] top level, [i, j] = child j of the group at i, … */
export type StepPath = number[];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
let seq = 0;
const uid = (): string => `s${Date.now().toString(36)}${(++seq).toString(36)}`;

function build(step: unknown, src: (string | number)[] | undefined): EStep {
  const st = isObj(step) ? structuredClone(step) : {};
  const g = isObj(st.group) && Array.isArray(st.group.steps) ? (st.group.steps as unknown[]) : undefined;
  if (g && isObj(st.group)) {
    const { steps: _s, ...rest } = st.group;
    st.group = rest;
    return { id: uid(), ...(src ? { src } : {}), step: st, children: g.map((c, j) => build(c, src ? [...src, 'group', 'steps', j] : undefined)) };
  }
  return { id: uid(), ...(src ? { src } : {}), step: st };
}

/** Model of a parsed script (as written). */
export function toModel(script: unknown): EModel {
  const s = isObj(script) ? structuredClone(script) : {};
  const { steps, ...header } = s;
  return { header, steps: (Array.isArray(steps) ? steps : []).map((st, i) => build(st, ['steps', i])) };
}

/** What the server serializes (engine ScriptEdit). */
export function toPayload(m: EModel): ScriptEditPayload {
  const conv = (e: EStep): StepEditPayload => ({ ...(e.src ? { src: e.src } : {}), step: e.step, ...(e.children ? { children: e.children.map(conv) } : {}) });
  return { header: m.header, steps: m.steps.map(conv) };
}

/** Plain step object (group children folded back). */
export function plainStep(e: EStep): Obj {
  if (e.children && isObj(e.step.group)) return { ...e.step, group: { ...e.step.group, steps: e.children.map(plainStep) } };
  return e.step;
}

/** Plain script object of the model. */
export function fromModel(m: EModel): Obj {
  return { ...m.header, steps: m.steps.map(plainStep) };
}

const clone = (m: EModel): EModel => structuredClone(m);

/** The list holding `path`'s step and its index there. */
function locate(m: EModel, path: StepPath): { list: EStep[]; index: number } {
  let list = m.steps;
  for (let d = 0; d < path.length - 1; d++) {
    const g = list[path[d]!];
    if (!g?.children) throw new Error(`no group at ${path.slice(0, d + 1).join('.')}`);
    list = g.children;
  }
  const index = path[path.length - 1]!;
  return { list, index };
}

export function getStep(m: EModel, path: StepPath): EStep | undefined {
  try {
    const { list, index } = locate(m, path);
    return list[index];
  } catch {
    return undefined;
  }
}

/** Engine step id of a path ("3", "4.2"). */
export const stepIdOf = (path: StepPath): string => path.map((i) => i + 1).join('.');

/** Replace a step's object (form edits). A group keeps its children. */
export function setStep(m: EModel, path: StepPath, step: Obj): EModel {
  const n = clone(m);
  const { list, index } = locate(n, path);
  const cur = list[index]!;
  const st = structuredClone(step);
  if (isObj(st.group)) {
    const { steps: _s, ...rest } = st.group;
    st.group = rest;
    list[index] = { ...cur, step: st, children: cur.children ?? [] };
  } else {
    const { children: _c, ...plain } = cur;
    list[index] = { ...plain, step: st };
  }
  return n;
}

/** Insert a new step at `path` (the index is the insert position in its list). */
export function addStep(m: EModel, path: StepPath, step: Obj): EModel {
  const n = clone(m);
  const { list, index } = locate(n, path);
  list.splice(Math.min(Math.max(index, 0), list.length), 0, build(step, undefined));
  return n;
}

export function deleteStep(m: EModel, path: StepPath): EModel {
  const n = clone(m);
  const { list, index } = locate(n, path);
  list.splice(index, 1);
  return n;
}

/** A copy right below (a new step: no source path). */
export function duplicateStep(m: EModel, path: StepPath): EModel {
  const n = clone(m);
  const { list, index } = locate(n, path);
  const strip = (e: EStep): EStep => ({ id: uid(), step: structuredClone(e.step), ...(e.children ? { children: e.children.map(strip) } : {}) });
  list.splice(index + 1, 0, strip(list[index]!));
  return n;
}

/** Move within the same list: `to` is the target index (drag-and-drop, up/down). */
export function moveStep(m: EModel, path: StepPath, to: number): EModel {
  const n = clone(m);
  const { list, index } = locate(n, path);
  if (to < 0 || to >= list.length || to === index) return m;
  const [item] = list.splice(index, 1);
  list.splice(to, 0, item!);
  return n;
}

export const moveUp = (m: EModel, path: StepPath): EModel => moveStep(m, path, path[path.length - 1]! - 1);
export const moveDown = (m: EModel, path: StepPath): EModel => moveStep(m, path, path[path.length - 1]! + 1);

/**
 * "묶음으로 넣기": into the group right above (as its last step); when the step above is not a
 * group, the step is wrapped in a new group in place.
 */
export function groupIn(m: EModel, path: StepPath, newGroupName = '새 묶음'): EModel {
  const n = clone(m);
  const { list, index } = locate(n, path);
  const prev = list[index - 1];
  const [item] = list.splice(index, 1);
  if (prev?.children) prev.children.push(item!);
  else list.splice(index, 0, { id: uid(), step: { group: { name: newGroupName } }, children: [item!] });
  return n;
}

/** "묶음에서 빼기": right below its group, one level up. */
export function groupOut(m: EModel, path: StepPath): EModel {
  if (path.length < 2) return m;
  const n = clone(m);
  const { list, index } = locate(n, path);
  const [item] = list.splice(index, 1);
  const parentPath = path.slice(0, -1);
  const parent = locate(n, parentPath);
  parent.list.splice(parent.index + 1, 0, item!);
  return n;
}

export function setHeader(m: EModel, header: Obj): EModel {
  return { header: structuredClone(header), steps: m.steps };
}

/** Templates for "단계 추가" (분류 메뉴). */
export const NEW_STEP_KINDS: { kind: string; label: string; make: () => Obj }[] = [
  { kind: 'goto', label: '이동', make: () => ({ goto: '/' }) },
  { kind: 'click', label: '클릭', make: () => ({ click: { target: { role: 'button', name: '' } } }) },
  { kind: 'fill', label: '입력', make: () => ({ fill: { target: { label: '' }, value: '' } }) },
  { kind: 'select', label: '선택/체크', make: () => ({ check: { target: { label: '' } } }) },
  { kind: 'press', label: '키', make: () => ({ press: { key: 'Enter' } }) },
  { kind: 'expect', label: '확인', make: () => ({ expect: { visible: { text: '' } } }) },
  { kind: 'measure', label: '측정', make: () => ({ measure: ['web-vitals', 'timing'] }) },
  { kind: 'wait', label: '대기', make: () => ({ wait: { ms: 1000 } }) },
  { kind: 'expectDownload', label: '다운로드 확인', make: () => ({ expectDownload: { trigger: { click: { target: { text: '' } } }, type: 'pdf' } }) },
  { kind: 'visual', label: '시각 비교', make: () => ({ visual: { name: 'screen' } }) },
  { kind: 'group', label: '묶음', make: () => ({ group: { name: '새 묶음', steps: [] } }) },
];

/** Flatten for display: every step with its path and depth (group children follow their group). */
export function flatten(m: EModel): { path: StepPath; depth: number; step: EStep }[] {
  const out: { path: StepPath; depth: number; step: EStep }[] = [];
  const walk = (list: EStep[], base: StepPath): void =>
    list.forEach((e, i) => {
      const path = [...base, i];
      out.push({ path, depth: base.length, step: e });
      if (e.children) walk(e.children, path);
    });
  walk(m.steps, []);
  return out;
}

/** Map validation paths ("steps[2].group.steps[0].click.target") to step paths ([2, 0]). */
export function issueStepPath(issuePath: string): StepPath | undefined {
  const out: number[] = [];
  const re = /(?:^|\.group\.)steps\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(issuePath)) && m.index === last) {
    out.push(Number(m[1]));
    last = re.lastIndex;
  }
  return out.length ? out : undefined;
}
