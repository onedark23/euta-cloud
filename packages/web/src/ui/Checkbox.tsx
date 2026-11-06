// Checkbox · Switch: native checkbox inputs (checked = --accent). Switch is for on/off settings and keeps
// `role="switch"` on the input.
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cx } from './cx';

type CheckProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'> & { label: ReactNode; className?: string };

export function Checkbox({ label, className, ...rest }: CheckProps) {
  return (
    <label className={cx('check', className)}>
      <input type="checkbox" {...rest} />
      <span>{label}</span>
    </label>
  );
}

export function Switch({ label, className, ...rest }: CheckProps) {
  return (
    <label className={cx('switch', className)}>
      <input type="checkbox" role="switch" {...rest} />
      <span className="switch-track" aria-hidden="true" />
      <span>{label}</span>
    </label>
  );
}
