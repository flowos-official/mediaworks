import type { ReactNode } from 'react';
import { Settings } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import PageHeader from '@/components/nav/PageHeader';
import GroupSubNav from '@/components/nav/GroupSubNav';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('nav.groupHeader.admin');
  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <PageHeader icon={Settings} title={t('title')} subtitle={t('subtitle')} />
      <div className="space-y-6">
        <GroupSubNav groupKey="admin" />
        {children}
      </div>
    </main>
  );
}
