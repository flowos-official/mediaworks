import Link from 'next/link';
import { getTranslations, getLocale } from 'next-intl/server';
import LanguageSwitcher from './LanguageSwitcher';
import UserMenu from './UserMenu';
import { BarChart3, Calendar, Clapperboard, Users } from 'lucide-react';
import { getServerClient } from '@/lib/supabase/server';
import type { Role } from '@/lib/auth/route-permissions';

export default async function Navbar() {
  const t = await getTranslations('nav');
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

  const isViewer = role === 'viewer';
  const isAdmin = role === 'admin';
  const homeHref = isViewer ? `/${locale}/analytics/products` : `/${locale}`;

  return (
    <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href={homeHref} className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <BarChart3 size={18} className="text-white" />
            </div>
            <span className="text-lg font-bold text-gray-900">MediaWorks</span>
          </Link>
          <div className="flex items-center gap-4">
            {role && !isViewer && (
              <>
                <Link
                  href={`/${locale}`}
                  className="text-sm text-gray-600 hover:text-gray-900 font-medium"
                >
                  {t('home')}
                </Link>
                <Link
                  href={`/${locale}/broadcasts`}
                  className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1"
                >
                  <Calendar size={14} />
                  {t('broadcasts')}
                </Link>
                <Link
                  href={`/${locale}/screenplays`}
                  className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1"
                >
                  <Clapperboard size={14} />
                  {t('screenplays')}
                </Link>
                <Link
                  href={`/${locale}/analytics`}
                  className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1"
                >
                  <BarChart3 size={14} />
                  {t('analytics')}
                </Link>
              </>
            )}
            {isViewer && (
              <Link
                href={`/${locale}/analytics/products`}
                className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1"
              >
                <BarChart3 size={14} />
                {t('analytics')}
              </Link>
            )}
            {isAdmin && (
              <Link
                href={`/${locale}/admin/users`}
                className="text-sm text-gray-600 hover:text-gray-900 font-medium flex items-center gap-1"
              >
                <Users size={14} />
                {t('userManagement')}
              </Link>
            )}
            <LanguageSwitcher />
            <UserMenu email={user?.email ?? null} role={role} locale={locale} />
          </div>
        </div>
      </div>
    </nav>
  );
}
