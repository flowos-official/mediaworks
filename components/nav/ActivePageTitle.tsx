'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { findActiveGroup, findActiveMember } from '@/lib/nav/groups';

interface ActivePageTitleProps {
  fallbackTitle: string;
  subtitle?: string;
}

export default function ActivePageTitle({ fallbackTitle, subtitle }: ActivePageTitleProps) {
  const pathname = usePathname();
  const t = useTranslations();
  const activeGroup = findActiveGroup(pathname);
  const activeMember = activeGroup ? findActiveMember(activeGroup, pathname) : null;
  const pageTitle = activeMember ? t(activeMember.labelKey) : fallbackTitle;
  const contextLine = pageTitle === fallbackTitle
    ? subtitle
    : [fallbackTitle, subtitle].filter(Boolean).join(' · ');

  return (
    <>
      <h1 className="truncate text-xl font-bold tracking-[-0.025em] text-foreground sm:text-2xl">{pageTitle}</h1>
      {contextLine && (
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground sm:text-sm">{contextLine}</p>
      )}
    </>
  );
}
