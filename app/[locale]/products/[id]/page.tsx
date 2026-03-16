import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import Navbar from '@/components/Navbar';
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
import PdfDownload from '@/components/report/PdfDownload';
import { ArrowLeft, Package, Calendar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

async function getProduct(id: string) {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
  const res = await fetch(`${baseUrl}/api/products/${id}`, {
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function ProductReportPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  const t = await getTranslations({ locale, namespace: 'report' });
  const tHome = await getTranslations({ locale, namespace: 'home' });

  const data = await getProduct(id);
  if (!data || !data.product) notFound();

  const { product, research } = data;

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <Link
              href={`/${locale}`}
              className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700"
            >
              <ArrowLeft size={16} />
              Back
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{product.name}</h1>
              <div className="flex items-center gap-3 mt-1">
                <span className="flex items-center gap-1 text-xs text-gray-500">
                  <Calendar size={12} />
                  {new Date(product.created_at).toLocaleDateString()}
                </span>
                <Badge className="bg-green-100 text-green-700 text-xs border-0">
                  {tHome('status.completed')}
                </Badge>
              </div>
            </div>
          </div>

          {research && (
            <PdfDownload product={product} research={research} />
          )}
        </div>

        {!research ? (
          <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-8 text-center">
            <p className="text-yellow-700">
              {product.status === 'analyzing'
                ? t('generating')
                : 'Report not available yet.'}
            </p>
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
          </div>
        )}
      </main>
    </div>
  );
}
