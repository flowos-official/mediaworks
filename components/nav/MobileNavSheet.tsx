'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, Menu, Radio, X } from 'lucide-react';
import { localePath } from '@/lib/i18n/locale-path';
import {
  NAV_GROUPS,
  findActiveGroup,
  findActiveMember,
  stripLocale,
  visibleMembersForRole,
} from '@/lib/nav/groups';
import type { Role } from '@/lib/auth/route-permissions';

interface Props {
  role: Role;
  locale: string;
  memberBadges?: Record<string, number>;
}

export default function MobileNavSheet({ role, locale, memberBadges }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const t = useTranslations();
  const pathname = usePathname();
  const activeGroup = findActiveGroup(pathname);
  const activeMemberHref = activeGroup ? findActiveMember(activeGroup, pathname)?.href ?? null : null;
  const isGuideActive = stripLocale(pathname) === '/guide';

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), summary, [tabindex]:not([tabindex="-1"])'),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const previousBodyOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    const trigger = triggerRef.current;
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(
      () => dialogRef.current?.querySelector<HTMLElement>('[data-close-nav]')?.focus(),
      0,
    );
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
      trigger?.focus();
    };
  }, [open]);

  const groups = NAV_GROUPS
    .map((group) => ({ group, visibleMembers: visibleMembersForRole(group, role) }))
    .filter(({ group, visibleMembers }) =>
      group.visibility[role] !== 'hidden' &&
      (group.visibility[role] === 'productsOnly' || visibleMembers.length > 0),
    );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open navigation"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground md:hidden"
      >
        <Menu size={19} />
      </button>
      {open && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Workspace navigation"
          className="fixed inset-0 z-[80] overflow-hidden bg-background md:hidden"
        >
          <div className="flex h-16 items-center justify-between border-b border-border px-4">
            <div>
              <div className="text-sm font-bold">Workspace navigation</div>
              <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                <span className="mw-status-dot" /> MediaWorks online
              </div>
            </div>
            <button
              data-close-nav
              type="button"
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
              className="inline-flex size-10 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground"
            >
              <X size={18} />
            </button>
          </div>
          <nav className="mw-scrollbar h-[calc(100dvh-4rem)] overflow-y-auto p-4">
            <Link
              href={localePath(locale, '/guide')}
              onClick={() => setOpen(false)}
              className={`mb-3 flex min-h-11 items-center gap-2 rounded-xl border px-3 text-sm font-medium ${
                isGuideActive ? 'border-primary/30 bg-primary/10 text-primary' : 'border-border bg-card text-foreground'
              }`}
            >
              <Radio size={15} /> {t('nav.guide')}
            </Link>
            <div className="space-y-3">
              {groups.map(({ group, visibleMembers }) => {
                const isActiveGroup = activeGroup?.key === group.key;
                const members = group.visibility[role] === 'productsOnly'
                  ? group.members.filter((member) => member.href === '/analytics/products')
                  : visibleMembers;
                return (
                  <details key={group.key} className="group overflow-hidden rounded-xl border border-border bg-card" open={isActiveGroup}>
                    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between px-3.5 text-sm font-semibold marker:hidden">
                      <span>{t(group.labelKey)}</span>
                      <ChevronDown size={15} className="text-muted-foreground transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="space-y-1 border-t border-border bg-muted/20 p-2">
                      {members.map((member) => {
                        const active = activeMemberHref === member.href;
                        const badge = memberBadges?.[member.href] ?? 0;
                        return (
                          <Link
                            key={member.href}
                            href={localePath(locale, member.href)}
                            onClick={() => setOpen(false)}
                            className={`flex min-h-11 items-center justify-between rounded-lg px-3 text-sm ${
                              active ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'
                            }`}
                          >
                            {t(member.labelKey)}
                            {badge > 0 && (
                              <span className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${active ? 'bg-white/18 text-white' : 'bg-primary/10 text-primary'}`}>
                                {badge}
                              </span>
                            )}
                          </Link>
                        );
                      })}
                    </div>
                  </details>
                );
              })}
            </div>
          </nav>
        </div>
      )}
    </>
  );
}
