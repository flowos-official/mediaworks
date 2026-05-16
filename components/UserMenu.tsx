'use client';

import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { Role } from '@/lib/auth/route-permissions';
import { localePath } from '@/lib/i18n/locale-path';

export default function UserMenu({
  email,
  role,
  locale,
}: {
  email: string | null;
  role: Role | null;
  locale: string;
}) {
  const router = useRouter();
  const t = useTranslations('auth');

  if (!email || !role) {
    return (
      <a
        href={localePath(locale, '/login')}
        className="text-sm font-medium text-blue-600 hover:underline"
      >
        {t('login.submit')}
      </a>
    );
  }

  async function logout() {
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    await sb.auth.signOut();
    router.replace(localePath(locale, '/login'));
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="text-xs">
        {t(`roleBadge.${role}`)}
      </Badge>
      <span className="text-sm text-gray-700 hidden sm:inline">{email}</span>
      <Button variant="ghost" size="sm" onClick={logout}>
        {t('logout')}
      </Button>
    </div>
  );
}
