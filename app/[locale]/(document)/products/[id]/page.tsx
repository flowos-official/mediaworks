import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import MarketabilitySection from '@/components/report/MarketabilitySection';
import DemographicsSection from '@/components/report/DemographicsSection';
import SeasonalitySection from '@/components/report/SeasonalitySection';
import CogsSection from '@/components/report/CogsSection';
import InfluencersSection from '@/components/report/InfluencersSection';
import ContentIdeasSection from '@/components/report/ContentIdeasSection';
import CompetitorSection from '@/components/report/CompetitorSection';
import BroadcastScriptSection from '@/components/report/BroadcastScriptSection';
import JapanExportSection from '@/components/report/JapanExportSection';
import DistributionChannelSection from '@/components/report/DistributionChannelSection';
import PricingStrategySection from '@/components/report/PricingStrategySection';
import MarketingStrategySection from '@/components/report/MarketingStrategySection';
import KoreaMarketSection from '@/components/report/KoreaMarketSection';
import LiveCommerceSection from '@/components/report/LiveCommerceSection';
import ResearchSourcesSection from "@/components/report/ResearchSourcesSection";
import PdfDownload from '@/components/report/PdfDownload';
import AnalyzingPoll from '@/components/products/AnalyzingPoll';
import { ArrowLeft, Package, Calendar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { localePath } from '@/lib/i18n/locale-path';
import { getServerClient } from '@/lib/supabase/server';

type ProductStatus = 'pending' | 'extracted' | 'analyzing' | 'completed' | 'failed';

const STATUS_BADGE_CLASS: Record<ProductStatus, string> = {
  pending: 'bg-gray-100 text-gray-700 border-0',
  extracted: 'bg-blue-100 text-blue-700 border-0',
  analyzing: 'bg-amber-100 text-amber-700 border-0',
  completed: 'bg-green-100 text-green-700 border-0',
  failed: 'bg-red-100 text-red-700 border-0',
};

function normalizeStatus(s: string | null | undefined): ProductStatus {
  if (s === 'pending' || s === 'extracted' || s === 'analyzing' || s === 'completed' || s === 'failed') {
    return s;
  }
  return 'pending';
}

// Allow only same-origin relative paths for the back link to avoid open-redirect.
function safeBackPath(from: string | undefined, fallback: string): string {
  if (!from) return fallback;
  if (!from.startsWith('/') || from.startsWith('//')) return fallback;
  return from;
}

// Server-side fetch via Supabase directly. The previous implementation made
// an HTTP round-trip to /api/products/[id] using NEXT_PUBLIC_SITE_URL, which
// (a) silently sent the request to the production URL in local dev when
// NEXT_PUBLIC_SITE_URL was set to prod, and (b) failed to forward the user's
// auth cookies, causing 401 → 404 on this page in local dev. Direct query
// inherits the user's session via getServerClient and is enforced by RLS
// (products is Group B — member/admin only).
async function getProduct(id: string) {
  const sb = await getServerClient();

  const { data: product, error: productError } = await sb
    .from('products')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (productError || !product) return null;

  const { data: research } = await sb
    .from('research_results')
    .select('*')
    .eq('product_id', id)
    .maybeSingle();

  // Merge extended fields from raw_json.research (distribution_channels,
  // live_commerce, etc.) — they have no dedicated DB columns. Mirrors the
  // merge logic in app/api/products/[id]/route.ts.
  let mergedResearch = research;
  if (research?.raw_json?.research) {
    const { raw_json, ...dbFields } = research;
    const rawResearch = raw_json.research as Record<string, unknown>;
    mergedResearch = { ...rawResearch, ...dbFields, raw_json };
  }

  return { product, research: mergedResearch };
}

export default async function ProductReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { locale, id } = await params;
  const { from } = await searchParams;
  const t = await getTranslations({ locale, namespace: 'report' });
  const tDetail = await getTranslations({ locale, namespace: 'productDetail' });

  const data = await getProduct(id);
  if (!data || !data.product) notFound();

  const { product, research } = data;
  const status = normalizeStatus(product.status);
  const backPath = safeBackPath(from, '/analytics/products');

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <Link
              href={localePath(locale, backPath)}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
            >
              <ArrowLeft size={16} />
              {t("back")}
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{product.name}</h1>
              <div className="flex items-center gap-3 mt-1">
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <Calendar size={12} />
                  {new Date(product.created_at).toLocaleDateString()}
                </span>
                <Badge className={`${STATUS_BADGE_CLASS[status]} text-xs`}>
                  {tDetail(`status.${status}`)}
                </Badge>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            {research && <PdfDownload product={product} research={research} />}
          </div>
        </div>

        {!research ? (
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-8 text-center">
            <p className="text-yellow-700">
              {status === 'analyzing'
                ? t('generating')
                : tDetail('notAvailable')}
            </p>
            {status === 'analyzing' && <AnalyzingPoll />}
          </div>
        ) : (
          <div id="report-content" className="space-y-6">
            {/* Product Info */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-gray-900 mb-3 flex items-center gap-2">
                <Package size={20} className="text-blue-600" />
                {t('productInfo')}
              </h2>
              {product.description && (
                <p className="text-gray-600 leading-relaxed">{product.description}</p>
              )}
            </div>

            {/* Marketability */}
            <MarketabilitySection
              score={research.marketability_score}
              description={research.marketability_description}
              market_size={research.market_size}
              competitors={research.competitors}
              usp_points={research.usp_points}
              risk_analysis={research.risk_analysis}
              recommended_sales_timing={research.recommended_sales_timing}
              expected_roi={research.expected_roi}
            />

            {/* Demographics */}
            <DemographicsSection demographics={research.demographics} />

            {/* Seasonality */}
            <SeasonalitySection seasonality={research.seasonality} />

            {/* COGS */}
            <CogsSection cogs_estimate={research.cogs_estimate} />

            {/* Influencers */}
            <InfluencersSection influencers={research.influencers} />

            {/* Content Ideas */}
            <ContentIdeasSection content_ideas={research.content_ideas} />

            {/* Competitor Analysis */}
            {research.competitor_analysis && (
              <CompetitorSection
                competitors={research.competitor_analysis}
                recommendedPriceRange={research.recommended_price_range || ''}
              />
            )}

            {/* Japan Export Score */}
            {research.japan_export_fit_score != null && (
              <JapanExportSection
                score={research.japan_export_fit_score}
                recommendedPriceRange={research.recommended_price_range || ''}
              />
            )}

            {/* Broadcast Scripts */}
            {research.broadcast_scripts && (
              <BroadcastScriptSection scripts={research.broadcast_scripts} />
            )}

            {/* Distribution Channels */}
            {research.distribution_channels && research.distribution_channels.length > 0 && (
              <DistributionChannelSection channels={research.distribution_channels} />
            )}

            {/* Pricing Strategy */}
            {research.pricing_strategy && (
              <PricingStrategySection pricingStrategy={research.pricing_strategy} />
            )}

            {/* Marketing Strategy */}
            {research.marketing_strategy && research.marketing_strategy.length > 0 && (
              <MarketingStrategySection strategies={research.marketing_strategy} />
            )}

            {/* Korea Market */}
            {research.korea_market_fit && (
              <KoreaMarketSection koreaMarket={research.korea_market_fit} />
            )}

            {/* Live Commerce */}
            {research.live_commerce && (
              <LiveCommerceSection data={research.live_commerce} />
            )}

            {/* Research Sources */}
            {research.raw_json?.search_results && (
              <ResearchSourcesSection
                searchResults={research.raw_json.search_results as Record<string, string>}
              />
            )}
          </div>
        )}
    </>
  );
}
