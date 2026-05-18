'use client';

import MDStrategyPanel from '@/components/analytics/MDStrategyPanel';
import { StrategySubTabs } from '@/components/analytics/StrategySubTabs';

export default function ExpansionListPage() {
  return (
    <>
      <StrategySubTabs />
      <MDStrategyPanel mode="list" />
    </>
  );
}
