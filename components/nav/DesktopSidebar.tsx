'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import BrandIdentity from '@/components/brand/BrandIdentity';
import { appConfig } from '@/config/app';
import DesktopNav from './DesktopNav';
import WorkspaceControls from './WorkspaceControls';
import type { Role } from '@/lib/auth/route-permissions';

const SIDEBAR_STORAGE_KEY = appConfig.storage.sidebarCollapsedKey;

interface Props {
  logoHref: string;
  email: string | null;
  role: Role | null;
  locale: string;
  memberBadges: Record<string, number>;
}

function applySidebarState(collapsed: boolean) {
  document.documentElement.dataset.sidebarCollapsed = collapsed ? 'true' : 'false';
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? 'true' : 'false');
  } catch {
    // The rail still works when browser storage is unavailable.
  }
}

export default function DesktopSidebar({ logoHref, email, role, locale, memberBadges }: Props) {
  const t = useTranslations('nav.sidebar');
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    let stored = false;
    try {
      stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
    } catch {
      stored = document.documentElement.dataset.sidebarCollapsed === 'true';
    }
    document.documentElement.dataset.sidebarCollapsed = stored ? 'true' : 'false';
    const frame = window.requestAnimationFrame(() => setCollapsed(stored));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== '\\') return;
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select') || target?.isContentEditable) return;
      event.preventDefault();
      setCollapsed((current) => {
        const next = !current;
        applySidebarState(next);
        return next;
      });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function toggleSidebar() {
    setCollapsed((current) => {
      const next = !current;
      applySidebarState(next);
      return next;
    });
  }

  return (
    <aside className="mw-desktop-sidebar fixed inset-y-0 left-0 z-50 hidden w-[252px] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={collapsed ? t('expand') : t('collapse')}
        aria-expanded={!collapsed}
        title={`${collapsed ? t('expand') : t('collapse')} (⌘\\)`}
        className="absolute -right-3 top-5 z-10 inline-flex size-7 items-center justify-center rounded-full border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-md transition hover:bg-sidebar-accent focus-visible:ring-offset-sidebar"
      >
        {collapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
      </button>

      <div className="mw-sidebar-header border-b border-sidebar-border px-4 py-4">
        <Link href={logoHref} className="mw-sidebar-brand flex items-center gap-3 rounded-xl px-1 py-1" title={`${appConfig.brand.name} ${appConfig.brand.marketLabel}`}>
          <BrandIdentity variant="sidebar" />
        </Link>
        <div className="mw-workspace-status mt-4 flex items-center justify-between rounded-lg border border-sidebar-border bg-sidebar-accent/45 px-2.5 py-2" title={t('online')}>
          <span className="flex items-center gap-2 text-[11px] font-medium text-sidebar-foreground/70">
            <span className="mw-status-dot" />
            <span className="mw-sidebar-copy">{t('online')}</span>
          </span>
          <Activity size={13} className="mw-sidebar-activity text-primary" />
        </div>
      </div>

      {role ? (
        <DesktopNav role={role} locale={locale} memberBadges={memberBadges} />
      ) : (
        <div className="flex flex-1 flex-col justify-center px-6">
          <p className="mw-kicker mw-sidebar-copy">{appConfig.copy.guestKicker}</p>
          <p className="mw-sidebar-copy mt-3 text-sm leading-relaxed text-sidebar-foreground/65">
            {appConfig.copy.guestDescription}
          </p>
        </div>
      )}

      <div className="mw-sidebar-footer border-t border-sidebar-border p-3">
        <WorkspaceControls email={email} role={role} locale={locale} variant="desktop" />
      </div>
    </aside>
  );
}
