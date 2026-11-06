// Button · IconButton (SPEC UI 디자인 시스템 "공통 컴포넌트"): icon + text by default; icon-only buttons
// always carry a tooltip. Variants: primary (one per screen) · secondary (default) · ghost · danger.
import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';
import { cx } from './cx';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'sm';

/** The button look for non-button elements (e.g. a link that opens a file). */
export const buttonClass = (variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra?: string) =>
  cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', extra);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  /** Toggled-on state (e.g. a view switch that is open). */
  active?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', icon: Icon, active, className, type = 'button', children, ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClass(variant, size, cx(active && 'is-active', className))} {...rest}>
      {Icon && <Icon size={size === 'sm' ? 14 : 16} strokeWidth={2} aria-hidden="true" />}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  /** Accessible name and tooltip text. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** Only for tight repeated rows (reorder etc.). Target area ≥ 30px; tooltip required. */
export function IconButton({ icon: Icon, label, variant = 'secondary', size = 'sm', className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <Tooltip label={label}>
      <button type={type} aria-label={label} className={buttonClass(variant, size, cx('btn-icon', className))} {...rest}>
        <Icon size={size === 'sm' ? 14 : 16} strokeWidth={2} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
