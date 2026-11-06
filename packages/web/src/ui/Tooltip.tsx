// Tooltip: shown on hover / keyboard focus after 400ms (CSS — ui.css `.tip`). For icon-only buttons and
// truncated names.
import type { ReactNode } from 'react';

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="tip" data-tip={label}>
      {children}
    </span>
  );
}
