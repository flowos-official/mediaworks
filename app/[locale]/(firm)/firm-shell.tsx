'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { BarChart3 } from 'lucide-react';
import PageHeader from '@/components/nav/PageHeader';
import GroupSubNav from '@/components/nav/GroupSubNav';
import DateRangeFilter from '@/components/analytics/DateRangeFilter';
import { FirmFilterProvider, useAnalyticsFilter } from '@/lib/analytics/firm-filter-context';
import type { Role } from '@/lib/auth/route-permissions';
import { appConfig } from '@/config/app';

interface FirmShellProps {
  role: Role | null;
  title: string;
  subtitle?: string;
  children: ReactNode;
}

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

// Pages that don't need the date-range filter in the header.
const NO_DATE_FILTER_PATHS = ['/gallery'];

export default function FirmShell({ role, title, subtitle, children }: FirmShellProps) {
  const showFullChrome = role !== null && role !== 'viewer';
  const pathname = usePathname() ?? '';
  const showDateFilter = !NO_DATE_FILTER_PATHS.some((p) => pathname.includes(p));
  return (
    <FirmFilterProvider>
      <main className="mw-page">
        <PageHeader
          icon={BarChart3}
          title={title}
          subtitle={subtitle}
          action={showFullChrome && showDateFilter ? <FilterAction /> : undefined}
          eyebrow={appConfig.copy.analyticsEyebrow}
        />
        <div className="mw-page-stack">
          {showFullChrome && <GroupSubNav groupKey="firm" role={role} />}
          {children}
        </div>
      </main>
    </FirmFilterProvider>
  );
}
