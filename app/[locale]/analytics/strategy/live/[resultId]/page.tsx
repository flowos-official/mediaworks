import { notFound } from 'next/navigation';
import { getServiceClient } from '@/lib/supabase';
import LiveCommercePanel, { type SavedLCData } from '@/components/analytics/LiveCommercePanel';
import { StrategySubTabs } from '@/components/analytics/StrategySubTabs';

export default async function LiveCommerceDetailPage({
  params,
}: {
  params: Promise<{ locale: string; resultId: string }>;
}) {
  const { resultId } = await params;
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('live_commerce_strategies')
    .select('*')
    .eq('id', resultId)
    .single();

  if (error || !data) {
    notFound();
  }

  const initialData: SavedLCData = {
    id: data.id,
    created_at: data.created_at,
    goal_analysis: data.goal_analysis ?? undefined,
    market_research: data.market_research ?? undefined,
    platform_analysis: data.platform_analysis ?? undefined,
    content_strategy: data.content_strategy ?? undefined,
    execution_plan: data.execution_plan ?? undefined,
    risk_analysis: data.risk_analysis ?? undefined,
    search_sources: data.search_sources ?? [],
  };

  return (
    <>
      <StrategySubTabs />
      <LiveCommercePanel mode="detail" initialData={initialData} />
    </>
  );
}
