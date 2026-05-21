import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations, getLocale } from 'next-intl/server';
import { getServerClient } from '@/lib/supabase/server';
import { isViewerAllowedPath, type Role } from '@/lib/auth/route-permissions';
import { localePath } from '@/lib/i18n/locale-path';
import FirmShell from './firm-shell';

export default async function FirmLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('nav.groupHeader.firm');
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

  if (role === 'viewer') {
    const pathname = (await headers()).get('x-pathname') ?? '';
    if (!pathname || !isViewerAllowedPath(pathname)) {
      const locale = await getLocale();
      redirect(localePath(locale, '/analytics/products'));
    }
  }

  return (
    <FirmShell role={role} title={t('title')} subtitle={t('subtitle')}>
      {children}
    </FirmShell>
  );
}
