'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { localePath } from '@/lib/i18n/locale-path';
import { NAV_GROUPS, findActiveMember, type GroupKey } from '@/lib/nav/groups';

interface GroupSubNavProps {
  groupKey: GroupKey;
}

export default function GroupSubNav({ groupKey }: GroupSubNavProps) {
  const { locale } = useParams<{ locale: string }>();
  const pathname = usePathname();
  const t = useTranslations();
  const group = NAV_GROUPS.find((g) => g.key === groupKey);
  if (!group) return null;
  const activeHref = findActiveMember(group, pathname)?.href ?? null;

  return (
    <div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-xl shadow-sm w-fit">
      {group.members.map((m) => {
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
