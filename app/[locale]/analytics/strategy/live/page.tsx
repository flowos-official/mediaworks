'use client';

import LiveCommercePanel from '@/components/analytics/LiveCommercePanel';
import { StrategySubTabs } from '@/components/analytics/StrategySubTabs';

export default function LiveCommerceListPage() {
  return (
    <>
      <StrategySubTabs />
      <LiveCommercePanel mode="list" />
    </>
  );
}
