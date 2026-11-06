// Dialog: --overlay backdrop + --surface panel with --shadow-2. `onBackdropClick` closes on any click
// that reaches the backdrop (the screenshot viewer closes on a click anywhere, as before).
import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

export function Dialog({
  label,
  onBackdropClick,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { label: string; onBackdropClick?: () => void; children: ReactNode }) {
  return (
    <div className="dialog-back" onClick={onBackdropClick}>
      <div className={cx('dialog', className)} role="dialog" aria-modal="true" aria-label={label} {...rest}>
        {children}
      </div>
    </div>
  );
}

/** Dialog buttons: right-aligned, the confirming one last. */
export const DialogActions = ({ children }: { children: ReactNode }) => <div className="dialog-actions">{children}</div>;
