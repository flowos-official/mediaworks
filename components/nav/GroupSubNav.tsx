'use client';

import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { localePath } from '@/lib/i18n/locale-path';
import { NAV_GROUPS, findActiveMember, visibleMembersForRole, type GroupKey } from '@/lib/nav/groups';
import type { Role } from '@/lib/auth/route-permissions';

interface GroupSubNavProps {
  groupKey: GroupKey;
  role: Role;
}

export default function GroupSubNav({ groupKey, role }: GroupSubNavProps) {
  const { locale } = useParams<{ locale: string }>();
  const pathname = usePathname();
  const t = useTranslations();
  const group = NAV_GROUPS.find((g) => g.key === groupKey);
  if (!group) return null;
  const visibleMembers = visibleMembersForRole(group, role);
  if (visibleMembers.length === 0) return null;
  const activeHref = findActiveMember(group, pathname)?.href ?? null;

  return (
    <nav aria-label={`${groupKey} views`} className="mw-scrollbar -mx-1 flex w-[calc(100%+0.5rem)] gap-1 overflow-x-auto rounded-xl border border-border bg-card/90 p-1 shadow-sm lg:hidden">
      {visibleMembers.map((m) => {
        const isActive = activeHref === m.href;
        return (
          <Link
            key={m.href}
            href={localePath(locale, m.href)}
            prefetch
            className={`inline-flex min-h-10 shrink-0 items-center rounded-lg px-3 text-sm font-medium transition-all ${
              isActive ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {t(m.labelKey)}
          </Link>
        );
      })}
    </nav>
  );
}
