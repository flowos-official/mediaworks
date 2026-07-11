import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { Settings } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import PageHeader from '@/components/nav/PageHeader';
import GroupSubNav from '@/components/nav/GroupSubNav';
import { getServerAuth } from '@/lib/auth/server-auth';
import { localePath } from '@/lib/i18n/locale-path';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const auth = await getServerAuth(['admin']);
  if (!auth.ok) {
    redirect(auth.reason === 'unauthorized' ? localePath(locale, '/login') : localePath(locale));
  }

  const t = await getTranslations('nav.groupHeader.admin');
  return (
    <main className="mw-page">
      <PageHeader icon={Settings} title={t('title')} subtitle={t('subtitle')} eyebrow="System control" />
      <div className="mw-page-stack">
        <GroupSubNav groupKey="admin" role={auth.role} />
        {children}
      </div>
    </main>
  );
}
