// Tabs: pill group (--surface-2 track; the selected tab is --surface + shadow). Items are links (the
// router's Link). `asTablist` adds tablist/tab roles (project tabs); scope switches stay plain links.
import { Link } from '../router';
import { cx } from './cx';

export interface TabItem {
  key: string;
  label: string;
  href: string;
}

export function Tabs({ items, active, asTablist, label }: { items: TabItem[]; active: string; asTablist?: boolean; label?: string }) {
  return (
    <nav className="tabs" role={asTablist ? 'tablist' : undefined} aria-label={label}>
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cx('tab', t.key === active && 'is-active')}
          {...(asTablist ? { role: 'tab', 'aria-selected': t.key === active } : {})}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
