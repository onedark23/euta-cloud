// Minimal JSON-lines logger. Callers pass secret values to `redactor` so nothing that may echo a
// credential (engine stderr, error messages) reaches the log in clear text.
export type LogFn = (msg: string, fields?: Record<string, unknown>) => void;

export interface Logger {
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

export function jsonLogger(write: (line: string) => void = (l) => process.stdout.write(l)): Logger {
  const at = (level: string): LogFn => (msg, fields = {}) => write(`${JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })}\n`);
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

/** Replace every occurrence of the given values (and their URL encodings) with ***. */
export function redactor(values: string[]): (s: string) => string {
  const needles = [...new Set(values.filter((v) => v.length >= 3).flatMap((v) => [v, encodeURIComponent(v)]))].sort((a, b) => b.length - a.length);
  return (s) => needles.reduce((acc, n) => acc.split(n).join('***'), s);
}
