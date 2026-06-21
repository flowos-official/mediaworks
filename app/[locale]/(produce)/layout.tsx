import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { Clapperboard } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import PageHeader from '@/components/nav/PageHeader';
import GroupSubNav from '@/components/nav/GroupSubNav';
import { getServerAuth } from '@/lib/auth/server-auth';
import { localePath } from '@/lib/i18n/locale-path';

export const dynamic = 'force-dynamic';

export default async function ProduceLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const auth = await getServerAuth(['member', 'admin']);
  if (!auth.ok) {
    redirect(auth.reason === 'unauthorized' ? localePath(locale, '/login') : localePath(locale));
  }

  const t = await getTranslations('nav.groupHeader.produce');
  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <PageHeader icon={Clapperboard} title={t('title')} subtitle={t('subtitle')} />
      <div className="space-y-6">
        <GroupSubNav groupKey="produce" role={auth.role} />
        {children}
      </div>
    </main>
  );
}
