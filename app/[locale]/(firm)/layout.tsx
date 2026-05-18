'use client';

import type { ReactNode } from 'react';
import { BarChart3 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import PageHeader from '@/components/nav/PageHeader';
import GroupSubNav from '@/components/nav/GroupSubNav';
import DateRangeFilter from '@/components/analytics/DateRangeFilter';
import { FirmFilterProvider, useAnalyticsFilter } from '@/lib/analytics/firm-filter-context';

function FilterAction() {
  const { selectedYears, setSelectedYears, period, setPeriod } = useAnalyticsFilter();
  return (
    <DateRangeFilter
      years={[2025, 2026]}
      selectedYears={selectedYears}
      period={period}
      onYearsChange={setSelectedYears}
      onPeriodChange={setPeriod}
    />
  );
}

export default function FirmLayout({ children }: { children: ReactNode }) {
  const t = useTranslations('nav.groupHeader.firm');
  return (
    <FirmFilterProvider>
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <PageHeader
          icon={BarChart3}
          title={t('title')}
          subtitle={t('subtitle')}
          action={<FilterAction />}
        />
        <div className="space-y-6">
          <GroupSubNav groupKey="firm" />
          {children}
        </div>
      </main>
    </FirmFilterProvider>
  );
}
