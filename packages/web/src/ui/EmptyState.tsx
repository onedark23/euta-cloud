// EmptyState: round --accent-soft icon + one-line title (+ one-line description, + one next action).
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({ icon: Icon, title, description, action, testId }: { icon: LucideIcon; title: ReactNode; description?: ReactNode; action?: ReactNode; testId?: string }) {
  return (
    <div className="empty" data-testid={testId}>
      <span className="empty-icon" aria-hidden="true">
        <Icon size={18} strokeWidth={2} />
      </span>
      <p className="empty-title">{title}</p>
      {description && <p className="empty-desc">{description}</p>}
      {action}
    </div>
  );
}
