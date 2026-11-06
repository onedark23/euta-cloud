// Script validation on save, using the engine (same rules as euta-app's editor check, ADR-018):
// YAML must parse; schema + reference syntax must pass. `${secrets.*}` / `${env.*}` values are
// environment matters, so they are filled with a placeholder — saving doesn't need them.
import { collectRefs, parseYaml, scriptHash, validateScript, type ValidationIssue } from '@euta/core';

const PLACEHOLDER = 'placeholder';

export interface ScriptCheck {
  /** False when the text is not YAML at all (always rejected, even for external edits). */
  parsed: boolean;
  ok: boolean;
  issues: ValidationIssue[];
}

export function checkScript(source: string): ScriptCheck {
  const parsed = parseYaml(source);
  if (parsed.issues.length) return { parsed: false, ok: false, issues: parsed.issues };
  const value = parsed.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { parsed: true, ok: false, issues: [{ path: '', message: 'script must be a YAML mapping (version, name, steps, ...)' }] };
  }
  const env: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const r of collectRefs(value)) {
    if (r.ns === 'secrets') secrets[r.key] = PLACEHOLDER;
    else if (r.ns === 'env') env[r.key] = PLACEHOLDER;
  }
  // Explicit env map: the server's own process.env must never feed script validation.
  const issues = validateScript(source, { env, secrets });
  return { parsed: true, ok: issues.length === 0, issues };
}

export { scriptHash };
