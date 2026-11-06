// Scripts on screen (SPEC 계정 "스크립트 표시"): the YAML `name` in bold, the path small; "(이름 없음)" when
// the YAML has none. Picking scripts = search + check (UI ground rules): checked scripts move to the top in
// check order with their number. Also the path suggested for a new script from its name.
import { SCRIPT_PATH_MAX, type ScriptDto } from '@euta-cloud/shared';
import { useState, type ReactNode } from 'react';
import { Link } from '../router';
import { Checkbox, TextField } from '../ui';

const NO_NAME = '(이름 없음)';

/** Name (bold) + path (small). `stacked` puts the path on its own line (lists, titles). */
export function ScriptName({ name, path, href, stacked = false }: { name: string | null | undefined; path: string; href?: string | undefined; stacked?: boolean }) {
  const label = name ? <b className="script-title">{name}</b> : <span className="script-title muted">{NO_NAME}</span>;
  return (
    <span className={stacked ? 'script-label stacked' : 'script-label'} title={path}>
      {href ? <Link href={href}>{label}</Link> : label}
      <span className="script-path">{path}</span>
    </span>
  );
}

/** Plain text for confirms and tooltips: `이름 (경로)`. */
export const scriptText = (name: string | null | undefined, path: string) => `${name || NO_NAME} (${path})`;

const matches = (s: ScriptDto, q: string) => {
  const t = q.trim().toLowerCase();
  return !t || s.path.toLowerCase().includes(t) || (s.name ?? '').toLowerCase().includes(t);
};

/**
 * Search + check over the project's scripts. `picked` = checked ids in check order. `single` = at most one
 * (checking another replaces it). Checked ones stay on top (numbered when several may be picked).
 */
export function ScriptPicker({
  scripts,
  picked,
  onChange,
  single = false,
  label = '스크립트 찾기 (이름 또는 경로)',
  testId = 'script-picker',
  footer,
}: {
  scripts: ScriptDto[];
  picked: string[];
  onChange: (ids: string[]) => void;
  single?: boolean;
  label?: string;
  testId?: string;
  footer?: ReactNode;
}) {
  const [q, setQ] = useState('');
  const byId = new Map(scripts.map((s) => [s.id, s]));
  const top = picked.map((id) => byId.get(id)).filter((s): s is ScriptDto => !!s);
  const rest = scripts.filter((s) => !picked.includes(s.id) && matches(s, q));
  const toggle = (id: string) => {
    if (picked.includes(id)) onChange(picked.filter((x) => x !== id));
    else onChange(single ? [id] : [...picked, id]);
  };
  return (
    <div className="script-picker" data-testid={testId}>
      <TextField label={label} name={`${testId}-search`} value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      <ul className="plain pick-list">
        {top.map((s, i) => (
          <li key={s.id} className="row picked" data-testid="pick-candidate" data-path={s.path} data-picked="true">
            {!single && <span className="suite-order">{i + 1}</span>}
            <Checkbox label={<ScriptName name={s.name} path={s.path} />} checked onChange={() => toggle(s.id)} />
          </li>
        ))}
        {rest.map((s) => (
          <li key={s.id} className="row" data-testid="pick-candidate" data-path={s.path}>
            <Checkbox label={<ScriptName name={s.name} path={s.path} />} checked={false} onChange={() => toggle(s.id)} />
          </li>
        ))}
      </ul>
      {rest.length === 0 && q.trim() && <p className="muted small">맞는 스크립트가 없습니다.</p>}
      {footer}
    </div>
  );
}

/**
 * Path suggested for a new script named `name` — the app's TC file-name rule (lowercase letters, digits and
 * Hangul, NFC, dash-joined, ≤ 40 chars) + `.yaml`, `-2`, `-3` … when taken.
 */
export function suggestScriptPath(name: string, taken: Set<string>): string {
  const stem =
    name
      .normalize('NFC')
      .toLowerCase()
      .replace(/[^a-z0-9가-힣]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'new-script';
  const max = SCRIPT_PATH_MAX - '-999.yaml'.length;
  const base = stem.slice(0, max);
  let p = `${base}.yaml`;
  for (let n = 2; taken.has(p); n++) p = `${base}-${n}.yaml`;
  return p;
}
