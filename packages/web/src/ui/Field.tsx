// TextField · TextArea · Select: label above, help or error below (--fs-xs). The control stays a native
// element inside the <label>, so `getByLabel` and form semantics are unchanged.
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cx } from './cx';

interface FieldParts {
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  /** Class of the wrapping <label> (e.g. `grow`). */
  className?: string;
}

function Field({ label, help, error, className, children }: FieldParts & { children: ReactNode }) {
  return (
    <label className={cx('field', className)}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : help ? <span className="field-help">{help}</span> : null}
    </label>
  );
}

export type TextFieldProps = FieldParts & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> & { inputClassName?: string };

export function TextField({ label, help, error, className, inputClassName, ...rest }: TextFieldProps) {
  return (
    <Field label={label} help={help} error={error} className={className}>
      <input className={cx(!!error && 'is-invalid', inputClassName)} aria-invalid={error ? true : undefined} {...rest} />
    </Field>
  );
}

export type TextAreaProps = FieldParts & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>;

export function TextArea({ label, help, error, className, ...rest }: TextAreaProps) {
  return (
    <Field label={label} help={help} error={error} className={className}>
      <textarea className={cx(!!error && 'is-invalid')} aria-invalid={error ? true : undefined} {...rest} />
    </Field>
  );
}

export type SelectProps = FieldParts & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'>;

export function Select({ label, help, error, className, children, ...rest }: SelectProps) {
  return (
    <Field label={label} help={help} error={error} className={className}>
      <select className={cx(!!error && 'is-invalid')} aria-invalid={error ? true : undefined} {...rest}>
        {children}
      </select>
    </Field>
  );
}
