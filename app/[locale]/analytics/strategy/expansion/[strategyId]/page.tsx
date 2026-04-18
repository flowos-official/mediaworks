import { notFound } from 'next/navigation';
import { getServiceClient } from '@/lib/supabase';
import MDStrategyPanel, { type SavedStrategyData } from '@/components/analytics/MDStrategyPanel';
import { StrategySubTabs } from '@/components/analytics/StrategySubTabs';

export default async function ExpansionDetailPage({
  params,
}: {
  params: Promise<{ locale: string; strategyId: string }>;
}) {
  const { strategyId } = await params;
  const supabase = getServiceClient();

  const { data, error } = await supabase
    .from('md_strategies')
    .select('*')
    .eq('id', strategyId)
    .single();

  if (error || !data) {
    notFound();
  }

  const initialData: SavedStrategyData = {
    id: data.id,
    created_at: data.created_at,
    goal_analysis: data.goal_analysis ?? undefined,
    product_selection: data.product_selection ?? undefined,
    channel_strategy: data.channel_strategy ?? undefined,
    pricing_margin: data.pricing_margin ?? undefined,
    marketing_execution: data.marketing_execution ?? undefined,
    financial_projection: data.financial_projection ?? undefined,
    risk_contingency: data.risk_contingency ?? undefined,
  };

  return (
    <>
      <StrategySubTabs />
      <MDStrategyPanel mode="detail" initialData={initialData} />
    </>
  );
}
