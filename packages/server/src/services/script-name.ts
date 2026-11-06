// Script display name = the YAML `name:` of a given script text (SPEC 계정 "스크립트 표시", ADR-044).
// Read from the text each time instead of stored: a run shows the name of the version it pinned, and
// the list shows the current version's. Parsing is cached by content hash (the name is a function of
// the text), so list screens parse each distinct text once.
import { parseYaml } from '@euta/core';

const CACHE_MAX = 5000;
const cache = new Map<string, string | null>();

/** The script's `name:` (trimmed), or null when absent, empty or the text does not parse. */
export function scriptNameOf(source: string | null | undefined, contentHash?: string | null): string | null {
  if (!source) return null;
  const key = contentHash || null;
  if (key && cache.has(key)) return cache.get(key)!;
  let name: string | null = null;
  try {
    const v = parseYaml(source).value as { name?: unknown } | null;
    if (v && typeof v === 'object' && typeof v.name === 'string' && v.name.trim()) name = v.name.trim();
  } catch {
    name = null;
  }
  if (key) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(key, name);
  }
  return name;
}
