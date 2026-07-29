'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { Activity, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useTranslations } from 'next-intl';
import DesktopNav from './DesktopNav';
import WorkspaceControls from './WorkspaceControls';
import type { Role } from '@/lib/auth/route-permissions';

const SIDEBAR_STORAGE_KEY = 'mediaworks-sidebar-collapsed';

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
        <Link href={logoHref} className="mw-sidebar-brand flex items-center gap-3 rounded-xl px-1 py-1" title="LOTTE HOME SHOPPING · SONAR">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white shadow-[0_8px_22px_rgba(218,41,28,0.16)] ring-1 ring-primary/15">
            <Image src="/brand/lotte-symbol.svg" alt="LOTTE" width={31} height={31} priority />
          </span>
          <span className="mw-sidebar-copy min-w-0">
            <span className="block text-[13px] font-extrabold tracking-[-0.025em]">LOTTE HOME SHOPPING</span>
            <span className="mt-1 block text-[9px] font-bold uppercase tracking-[0.16em] text-primary">SONAR · BROADCAST AX</span>
          </span>
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
          <p className="mw-kicker mw-sidebar-copy">LOTTE HOME SHOPPING</p>
          <p className="mw-sidebar-copy mt-3 text-sm leading-relaxed text-sidebar-foreground/65">
            상품 데이터, 시장 리서치, 방송 심의와 제작을 하나의 운영 화면에 연결합니다.
          </p>
        </div>
      )}

      <div className="mw-sidebar-footer border-t border-sidebar-border p-3">
        <WorkspaceControls email={email} role={role} locale={locale} variant="desktop" />
      </div>
    </aside>
  );
}
