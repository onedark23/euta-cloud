// Result-file helpers shared by the script overlay and the run detail: step screenshots from
// `run.json` (DB steps carry no screenshot paths) and console / network failures from `steps.jsonl`.
import { encodePath } from '../router';

export interface StepFile {
  stepId: string;
  status: string;
  durationMs: number;
  error?: string;
  screenshot?: string;
  /** DSL `manual` step marker (reached when there is no `error`). */
  manual?: { instruction: string; reason?: string };
  expects?: { condition?: string; passed?: boolean; expected?: unknown; actual?: unknown }[];
}

export const fileUrl = (pid: string, runId: string, rel: string) => `/api/projects/${encodeURIComponent(pid)}/runs/${encodeURIComponent(runId)}/files/${encodePath(rel)}`;

/** Flatten engine `run.json` steps (groups have `children`) by step id. */
export function flattenRunJsonSteps(steps: unknown, out: Record<string, StepFile> = {}): Record<string, StepFile> {
  for (const s of Array.isArray(steps) ? (steps as (StepFile & { children?: unknown })[]) : []) {
    if (!s || typeof s.stepId !== 'string') continue;
    out[s.stepId] = s;
    if (s.children) flattenRunJsonSteps(s.children, out);
  }
  return out;
}

export async function loadRunJsonSteps(pid: string, runId: string): Promise<Record<string, StepFile>> {
  try {
    const res = await fetch(fileUrl(pid, runId, 'run.json'), { credentials: 'same-origin' });
    if (!res.ok) return {};
    const json = (await res.json()) as { steps?: unknown };
    return flattenRunJsonSteps(json.steps);
  } catch {
    return {};
  }
}

export interface ConsoleLine {
  level: string;
  text: string;
  stepId?: string;
}
export interface NetworkFailure {
  method?: string;
  url: string;
  status?: number;
  errorText?: string;
  stepId?: string;
}

/** Console errors/warnings and failed requests recorded in `steps.jsonl` (engine events, secrets already masked). */
export function parseEventLog(text: string): { console: ConsoleLine[]; network: NetworkFailure[] } {
  const consoleLines: ConsoleLine[] = [];
  const network: NetworkFailure[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const stepId = typeof e.stepId === 'string' ? e.stepId : undefined;
    if (e.type === 'console.message' && (e.level === 'error' || e.level === 'warning')) {
      consoleLines.push({ level: String(e.level), text: String(e.text ?? ''), ...(stepId ? { stepId } : {}) });
    } else if (e.type === 'network.failed') {
      network.push({
        url: String(e.url ?? ''),
        ...(typeof e.method === 'string' ? { method: e.method } : {}),
        ...(typeof e.status === 'number' ? { status: e.status } : {}),
        ...(typeof e.errorText === 'string' ? { errorText: e.errorText } : {}),
        ...(stepId ? { stepId } : {}),
      });
    }
  }
  return { console: consoleLines, network };
}
