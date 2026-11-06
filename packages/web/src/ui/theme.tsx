// Screen theme (SPEC "테마"): 시스템 / 밝게 / 어둡게, kept in localStorage and applied as <html data-theme>.
// "시스템" removes the attribute (tokens.css follows prefers-color-scheme). index.html applies the stored
// value before the first paint with the same key.
import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'euta-theme';

export function readTheme(): ThemePref {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(pref: ThemePref) {
  const el = document.documentElement;
  if (pref === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', pref);
  try {
    if (pref === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable — the choice lasts for this page only */
  }
}

const ICON = { system: Monitor, light: Sun, dark: Moon };

export function ThemeSelect() {
  const [pref, setPref] = useState<ThemePref>(readTheme);
  const Icon = ICON[pref];
  return (
    <label className="theme-select" title="화면 테마">
        <Icon size={16} strokeWidth={2} aria-hidden="true" />
        <select
          aria-label="화면 테마"
          value={pref}
          onChange={(e) => {
            const v = e.target.value as ThemePref;
            setPref(v);
            applyTheme(v);
          }}
          data-testid="theme-select"
        >
          <option value="system">시스템</option>
          <option value="light">밝게</option>
          <option value="dark">어둡게</option>
        </select>
    </label>
  );
}
