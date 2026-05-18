import type { ReactNode } from 'react';
import { getTranslations } from 'next-intl/server';
import { getServerClient } from '@/lib/supabase/server';
import type { Role } from '@/lib/auth/route-permissions';
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

  return (
    <FirmShell role={role} title={t('title')} subtitle={t('subtitle')}>
      {children}
    </FirmShell>
  );
}
