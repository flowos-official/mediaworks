// components/nav/MarketSubNav.tsx
'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { localePath } from '@/lib/i18n/locale-path';
import { NAV_GROUPS, findActiveMember } from '@/lib/nav/groups';

const GROUP = NAV_GROUPS.find((g) => g.key === 'market')!;

export default function MarketSubNav() {
  const { locale } = useParams<{ locale: string }>();
  const pathname = usePathname();
  const t = useTranslations();
  const activeHref = findActiveMember(GROUP, pathname)?.href ?? null;

  return (
    <div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-xl shadow-sm w-fit">
      {GROUP.members.map((m) => {
        const isActive = activeHref === m.href;
        return (
          <Link
            key={m.href}
            href={localePath(locale, m.href)}
            prefetch
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
              isActive ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            {t(m.labelKey)}
          </Link>
        );
      })}
    </div>
  );
}
