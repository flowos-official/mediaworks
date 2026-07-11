'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRight, Command, Search, X } from 'lucide-react';
import { NAV_GROUPS, visibleMembersForRole } from '@/lib/nav/groups';
import { localePath } from '@/lib/i18n/locale-path';
import type { Role } from '@/lib/auth/route-permissions';
import { useDialogBehavior } from '@/components/ui/use-dialog-behavior';

interface QuickNavProps {
  role: Role;
  locale: string;
  variant: 'mobile' | 'desktop';
}

export default function QuickNav({ role, locale, variant }: QuickNavProps) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useDialogBehavior(open, () => setOpen(false), dialogRef, { returnFocusRef: triggerRef });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const desktopViewport = window.matchMedia('(min-width: 768px)').matches;
      if ((variant === 'desktop') !== desktopViewport) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [variant]);

  const entries = useMemo(() => {
    const visible = NAV_GROUPS.flatMap((group) => {
      const visibility = group.visibility[role];
      if (visibility === 'hidden') return [];
      const members = visibility === 'productsOnly'
        ? group.members.filter((member) => member.href === '/analytics/products')
        : visibleMembersForRole(group, role);
      return members.map((member) => ({
        href: member.href,
        label: t(member.labelKey),
        group: t(group.labelKey),
      }));
    });
    return [...visible, { href: '/guide', label: t('nav.guide'), group: t('nav.quickNav.support') }];
  }, [role, t]);

  const normalized = query.trim().toLocaleLowerCase(locale);
  const results = normalized
    ? entries.filter((entry) => `${entry.label} ${entry.group}`.toLocaleLowerCase(locale).includes(normalized))
    : entries;

  const choose = (href: string) => {
    setOpen(false);
    setQuery('');
    router.push(localePath(locale, href));
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label={variant === 'mobile' ? t('nav.quickNav.open') : `${t('nav.quickNav.open')} ⌘K`}
        className={variant === 'mobile'
          ? 'inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground'
          : 'mw-quick-nav-button flex min-h-9 w-full items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent/35 px-2.5 text-[11px] font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground'}
      >
        <Search size={15} />
        {variant === 'desktop' && (
          <>
            <span className="mw-quick-nav-copy flex-1 text-left">{t('nav.quickNav.open')}</span>
            <kbd className="mw-quick-nav-copy rounded border border-sidebar-border bg-sidebar px-1.5 py-0.5 font-mono text-[9px]">⌘K</kbd>
          </>
        )}
      </button>

      {open && (
        <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/55 p-3 pt-[12vh] backdrop-blur-sm" onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="quick-nav-title" tabIndex={-1} className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <Command size={18} className="text-primary" />
              <div className="relative min-w-0 flex-1">
                <label id="quick-nav-title" htmlFor="quick-nav-search" className="sr-only">{t('nav.quickNav.title')}</label>
                <input
                  id="quick-nav-search"
                  data-dialog-autofocus
                  type="search"
                  value={query}
                  onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      setActiveIndex((index) => Math.min(index + 1, results.length - 1));
                    } else if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      setActiveIndex((index) => Math.max(index - 1, 0));
                    } else if (event.key === 'Enter' && results[activeIndex]) {
                      event.preventDefault();
                      choose(results[activeIndex].href);
                    }
                  }}
                  placeholder={t('nav.quickNav.placeholder')}
                  className="h-10 w-full bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
                />
              </div>
              <button type="button" onClick={() => setOpen(false)} className="inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t('nav.quickNav.close')}>
                <X size={16} />
              </button>
            </div>
            <div className="mw-scrollbar max-h-[55vh] overflow-y-auto p-2">
              <span className="sr-only" role="status" aria-live="polite">{t('nav.quickNav.resultCount', { count: results.length })}</span>
              {results.length > 0 ? results.map((entry, index) => (
                <button key={entry.href} type="button" onMouseEnter={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)} onClick={() => choose(entry.href)} className={`group flex min-h-12 w-full items-center gap-3 rounded-xl px-3 text-left hover:bg-muted focus-visible:bg-muted ${activeIndex === index ? 'bg-muted' : ''}`}>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><ArrowRight size={15} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{entry.label}</span>
                    <span className="block text-[10px] text-muted-foreground">{entry.group}</span>
                  </span>
                  <span className="font-mono text-[9px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">↵</span>
                </button>
              )) : (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">{t('nav.quickNav.empty')}</div>
              )}
            </div>
            <div className="border-t border-border bg-muted/35 px-4 py-2 text-[10px] text-muted-foreground">{t('nav.quickNav.hint')}</div>
          </div>
        </div>
      )}
    </>
  );
}
