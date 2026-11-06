// Card: a content group — --surface + --shadow-1, no border, radius --r-lg, padding --sp-4.
import type { HTMLAttributes } from 'react';
import { cx } from './cx';

export function Card({ as: Tag = 'section', className, ...rest }: HTMLAttributes<HTMLElement> & { as?: 'section' | 'div' }) {
  return <Tag className={cx('card', className)} {...rest} />;
}
