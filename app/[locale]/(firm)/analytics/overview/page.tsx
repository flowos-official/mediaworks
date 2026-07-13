'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import OverviewCards from '@/components/analytics/OverviewCards';
import RevenueTrendChart from '@/components/analytics/RevenueTrendChart';
import ProductMixChart from '@/components/analytics/ProductMixChart';
import TopProductsTable from '@/components/analytics/TopProductsTable';
import ProductDetailModal from '@/components/analytics/ProductDetailModal';
import { useAnalyticsFilter } from '@/lib/analytics/firm-filter-context';
import { useApiQuery } from '@/lib/client/api-cache';

export default function OverviewPage() {
  const tCommon = useTranslations('common');
  const { selectedYears, period } = useAnalyticsFilter();
  const yearParam = selectedYears.join(',');

  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);
  const overviewQuery = useApiQuery<Record<string, unknown>>(`/api/analytics/overview?year=${yearParam}`);
  const trendsQuery = useApiQuery<{ period: string; trends: unknown[] }>(`/api/analytics/trends?year=${yearParam}&period=${period}`);
  const productsQuery = useApiQuery<{ products: unknown[]; total: number }>(`/api/analytics/products?year=${yearParam}&limit=500`);
  const overview = overviewQuery.data;
  const trends = trendsQuery.data;
  const products = productsQuery.data;
  const loading = overviewQuery.isLoading || trendsQuery.isLoading || productsQuery.isLoading;
  const error = overviewQuery.error ?? trendsQuery.error ?? productsQuery.error;

  return (
    <>
      {error && (
        <div className="p-4 bg-red-600/10 border border-red-200 dark:border-red-900/40 rounded-lg text-sm text-red-700 dark:text-red-300">
          {error.message}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-600" />
          <span className="ml-2 text-sm text-muted-foreground">{tCommon('loading')}</span>
        </div>
      )}

      {!loading && overview && trends && products && (
        <div className="space-y-6">
          <OverviewCards data={overview as Parameters<typeof OverviewCards>[0]['data']} />
          <RevenueTrendChart
            data={trends.trends as Parameters<typeof RevenueTrendChart>[0]['data']}
            period={period}
          />
          <ProductMixChart
            data={(overview as { categoryBreakdown: Parameters<typeof ProductMixChart>[0]['data'] }).categoryBreakdown ?? []}
            products={(products?.products as { code: string; name: string; category: string | null; totalRevenue: number; totalQuantity: number }[]) ?? []}
          />
          <TopProductsTable
            products={(products.products as Parameters<typeof TopProductsTable>[0]['products'])}
            onSelectProduct={setSelectedProduct}
            compact
            limit={30}
          />
        </div>
      )}

      {selectedProduct && (
        <ProductDetailModal
          productCode={selectedProduct}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </>
  );
}
