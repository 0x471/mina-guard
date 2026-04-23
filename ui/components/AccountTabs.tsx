'use client';

import Link from 'next/link';

/**
 * Three-tab navigation strip per the M0 mockup's IA:
 *   Account · Activity · Delegation.
 * Used at the top of `/accounts/[address]`, `/activity/[address]`, and
 * `/delegation/[address]` so users can pivot between views of the same
 * guard without going up a level in the URL.
 */
export default function AccountTabs({
  address,
  active,
}: {
  address: string;
  active: 'account' | 'activity' | 'delegation';
}) {
  const tabs: Array<{ key: typeof active; label: string; href: string }> = [
    { key: 'account', label: 'Account', href: `/accounts/${address}` },
    { key: 'activity', label: 'Activity', href: `/activity/${address}` },
    { key: 'delegation', label: 'Delegation', href: `/delegation/${address}` },
  ];

  return (
    <nav className="flex gap-1 border-b border-safe-border mb-6 -mx-1 px-1 overflow-x-auto">
      {tabs.map((t) => {
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={isActive ? 'page' : undefined}
            className={`px-4 py-2 text-sm rounded-t-md border-b-2 transition-colors whitespace-nowrap ${
              isActive
                ? 'border-safe-green text-safe-green font-semibold'
                : 'border-transparent opacity-70 hover:opacity-100 hover:bg-safe-hover'
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
