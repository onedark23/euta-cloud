// Step-sentence diff of two script versions (SPEC 스크립트-보기-편집 "이력 화면"): steps are
// compared as their Korean sentences (engine describeStep), header fields by name. Copied from
// euta-app src/shared/script-diff.ts (keep in step — see ADR-029).
import { describeStep, stepText, type StepDescription } from '@euta/core/describe';

export interface DiffRow {
  kind: 'same' | 'added' | 'removed' | 'changed';
  /** Group nesting level (0 = top-level step). */
  depth: number;
  before?: string;
  after?: string;
}

export interface ScriptDiff {
  rows: DiffRow[];
  /** Changed header fields, in Korean ("이름", "변수", ...). */
  header: string[];
  added: number;
  removed: number;
  changed: number;
  /** "단계 2개 추가, 1개 변경" / "머리 정보 변경: 이름" / "변경 없음 (서식만)". */
  summary: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

export const HEADER_LABELS: Record<string, string> = {
  version: '버전',
  name: '이름',
  description: '설명',
  target: '대상 주소',
  browser: '브라우저 설정',
  vars: '변수',
  defaults: '기본값',
  record: '녹화 설정',
};

interface Line {
  depth: number;
  text: string;
  action: string;
}

function flatten(steps: unknown, depth = 0, out: Line[] = []): Line[] {
  for (const s of Array.isArray(steps) ? steps : []) {
    const d: StepDescription = describeStep(s);
    // A group line without its step count, so adding a child does not "change" the group.
    const text = d.action === 'group' ? stepText({ ...d, sentence: d.sentence.replace(/ \(단계 \d+개\)$/, '') }) : stepText(d);
    out.push({ depth, text, action: d.action });
    if (d.action === 'group' && isObj(s) && isObj(s.group)) flatten(s.group.steps, depth + 1, out);
  }
  return out;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Diff `before` → `after` (parsed scripts; `before` undefined = first version). */
export function diffScripts(before: unknown, after: unknown): ScriptDiff {
  const a = flatten(isObj(before) ? before.steps : []);
  const b = flatten(isObj(after) ? after.steps : []);
  const key = (l: Line) => `${l.depth}\u0000${l.text}`;
  // LCS table (scripts are small: hundreds of steps at most).
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = key(a[i]!) === key(b[j]!) ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  // Within a run of removals + additions, a removed and an added step of the same action at the
  // same depth are one "changed" step; anything else stays removed / added.
  const flush = (rem: Line[], add: Line[]): void => {
    const used = new Set<number>();
    for (const r of rem) {
      const k = add.findIndex((ad, x) => !used.has(x) && ad.action === r.action && ad.depth === r.depth);
      if (k >= 0) {
        used.add(k);
        rows.push({ kind: 'changed', depth: r.depth, before: r.text, after: add[k]!.text });
      } else rows.push({ kind: 'removed', depth: r.depth, before: r.text });
    }
    add.forEach((ad, x) => used.has(x) || rows.push({ kind: 'added', depth: ad.depth, after: ad.text }));
  };
  let rem: Line[] = [];
  let add: Line[] = [];
  while (i < n || j < m) {
    if (i < n && j < m && key(a[i]!) === key(b[j]!)) {
      flush(rem, add);
      rem = [];
      add = [];
      rows.push({ kind: 'same', depth: a[i]!.depth, before: a[i]!.text, after: b[j]!.text });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) add.push(b[j++]!);
    else rem.push(a[i++]!);
  }
  flush(rem, add);

  const header: string[] = [];
  if (before !== undefined) {
    const ha = isObj(before) ? before : {};
    const hb = isObj(after) ? after : {};
    for (const k of new Set([...Object.keys(ha), ...Object.keys(hb)])) {
      if (k === 'steps') continue;
      if (!same(ha[k], hb[k])) header.push(HEADER_LABELS[k] ?? k);
    }
  }
  const count = (k: DiffRow['kind']) => rows.filter((r) => r.kind === k).length;
  const added = count('added');
  const removed = count('removed');
  const changed = count('changed');
  let summary: string;
  if (before === undefined) summary = `처음 기록 (단계 ${b.length}개)`;
  else {
    const parts = [added ? `${added}개 추가` : '', changed ? `${changed}개 변경` : '', removed ? `${removed}개 삭제` : ''].filter(Boolean);
    const steps = parts.length ? `단계 ${parts.join(', ')}` : '';
    const head = header.length ? `머리 정보 변경: ${header.join(', ')}` : '';
    summary = [steps, head].filter(Boolean).join(' · ') || '단계 변화 없음 (서식·주석만)';
  }
  return { rows, header, added, removed, changed, summary };
}
