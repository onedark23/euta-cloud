// PageHeader: screen title (--fs-xl 700) + meta (badges) on the left, action buttons on the right.
import type { ReactNode } from 'react';

export function PageHeader({ title, titleTestId, meta, actions }: { title: ReactNode; titleTestId?: string; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div className="page-title">
        <h1 data-testid={titleTestId}>{title}</h1>
        {meta}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
