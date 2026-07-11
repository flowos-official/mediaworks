import Link from 'next/link';
import { getLocale } from 'next-intl/server';
import { BarChart3 } from 'lucide-react';
import DesktopSidebar from './nav/DesktopSidebar';
import MobileNavSheet from './nav/MobileNavSheet';
import WorkspaceControls from './nav/WorkspaceControls';
import { getServerClient } from '@/lib/supabase/server';
import type { Role } from '@/lib/auth/route-permissions';
import { localePath } from '@/lib/i18n/locale-path';

export default async function Navbar() {
  const locale = await getLocale();
  const sb = await getServerClient();
  const { data: { user } } = await sb.auth.getUser();
  let role: Role | null = null;
  let activePipelineCount = 0;
  if (user) {
    const [profileResult, pipelineResult] = await Promise.all([
      sb.from('profiles').select('role').eq('id', user.id).maybeSingle(),
      sb.from('product_selections').select('*', { count: 'exact', head: true }).neq('status', 'closed'),
    ]);
    const profile = profileResult.data;
    role = (profile?.role ?? null) as Role | null;
    if (!pipelineResult.error) activePipelineCount = pipelineResult.count ?? 0;
  }
  const logoHref =
    role === 'viewer'
      ? localePath(locale, '/analytics/products')
      : role
        ? localePath(locale, '/analytics/overview')
        : localePath(locale);
  const memberBadges = { '/analytics/pipeline': activePipelineCount };

  return (
    <>
      <header className="sticky top-0 z-50 flex h-16 items-center justify-between border-b border-border bg-background/94 px-4 backdrop-blur md:hidden">
        <Link href={logoHref} className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <BarChart3 size={17} />
          </span>
          <span>
            <span className="block text-sm font-bold tracking-[-0.02em]">MediaWorks</span>
            <span className="block font-mono text-[8px] uppercase tracking-[0.16em] text-muted-foreground/90">Broadcast OS</span>
          </span>
        </Link>
        <div className="flex items-center gap-1">
          <WorkspaceControls
            email={user?.email ?? null}
            role={role}
            locale={locale}
            variant="mobile"
          />
          {role && <MobileNavSheet role={role} locale={locale} memberBadges={memberBadges} />}
        </div>
      </header>

      <DesktopSidebar
        logoHref={logoHref}
        email={user?.email ?? null}
        role={role}
        locale={locale}
        memberBadges={memberBadges}
      />
    </>
  );
}
