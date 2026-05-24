// components/Navbar.tsx
import Link from 'next/link';
import { getLocale } from 'next-intl/server';
import UserMenu from './UserMenu';
import GroupDropdown from './nav/GroupDropdown';
import MobileNavSheet from './nav/MobileNavSheet';
import { BarChart3 } from 'lucide-react';
import { getServerClient } from '@/lib/supabase/server';
import type { Role } from '@/lib/auth/route-permissions';
import { localePath } from '@/lib/i18n/locale-path';
import { NAV_GROUPS } from '@/lib/nav/groups';

/** Fetch active (non-closed) pipeline count. Returns 0 on any failure. */
async function fetchActivePipelineCount(): Promise<number> {
  try {
    const sb = await getServerClient();
    const { count, error } = await sb
      .from('product_selections')
      .select('*', { count: 'exact', head: true })
      .neq('status', 'closed');
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

export default async function Navbar() {
  const locale = await getLocale();

  const sb = await getServerClient();
  const { data: { user } } = await sb.auth.getUser();
  let role: Role | null = null;
  if (user) {
    const { data: profile } = await sb
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle();
    role = (profile?.role ?? null) as Role | null;
  }

  // Fetch active pipeline count only for authenticated users; parallel with auth above.
  const activePipelineCount = role ? await fetchActivePipelineCount() : 0;

  // Logo landing: viewer → /analytics/products, others → /analytics/overview, no role → root.
  const logoHref =
    role === 'viewer'
      ? localePath(locale, '/analytics/products')
      : role
      ? localePath(locale, '/analytics/overview')
      : localePath(locale);

  return (
    <nav className="bg-background border-b border-border sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href={logoHref} className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <BarChart3 size={18} className="text-white" />
            </div>
            <span className="text-lg font-bold text-foreground">MediaWorks</span>
          </Link>

          {/* Desktop nav */}
          {role && (
            <div className="hidden md:flex items-center gap-6">
              {NAV_GROUPS.map((g) => (
                <GroupDropdown
                  key={g.key}
                  group={g}
                  role={role!}
                  locale={locale}
                  memberBadges={g.key === 'market' ? { '/analytics/pipeline': activePipelineCount } : undefined}
                />
              ))}
              <UserMenu
                email={user?.email ?? null}
                role={role}
                locale={locale}
                triggerId="user-menu-trigger-desktop"
              />
            </div>
          )}

          {/* Mobile nav */}
          {role && (
            <div className="flex md:hidden items-center gap-2">
              <UserMenu
                email={user?.email ?? null}
                role={role}
                locale={locale}
                triggerId="user-menu-trigger-mobile"
              />
              <MobileNavSheet
                role={role}
                locale={locale}
                memberBadges={{ '/analytics/pipeline': activePipelineCount }}
              />
            </div>
          )}

          {/* Logged-out fallback (login page itself) */}
          {!role && (
            <div className="flex items-center gap-2">
              <UserMenu
                email={null}
                role={null}
                locale={locale}
                triggerId="user-menu-trigger-guest"
              />
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
