'use client';

import { useEffect, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import OverviewCards from '@/components/analytics/OverviewCards';
import RevenueTrendChart from '@/components/analytics/RevenueTrendChart';
import ProductMixChart from '@/components/analytics/ProductMixChart';
import MarginAnalysisChart from '@/components/analytics/MarginAnalysisChart';
import TopProductsTable from '@/components/analytics/TopProductsTable';
import ProductDetailModal from '@/components/analytics/ProductDetailModal';
import { useAnalyticsFilter } from '../layout';

export default function OverviewPage() {
  const { selectedYears, period } = useAnalyticsFilter();
  const yearParam = selectedYears.join(',');

  const [overview, setOverview] = useState<Record<string, unknown> | null>(null);
  const [trends, setTrends] = useState<{ period: string; trends: unknown[] } | null>(null);
  const [products, setProducts] = useState<{ products: unknown[]; total: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);

  const fetchData = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [ovRes, trRes, prRes] = await Promise.all([
        fetch(`/api/analytics/overview?year=${yearParam}`, { signal }),
        fetch(`/api/analytics/trends?year=${yearParam}&period=${period}`, { signal }),
        fetch(`/api/analytics/products?year=${yearParam}&limit=500`, { signal }),
      ]);
      if (!ovRes.ok || !trRes.ok || !prRes.ok) throw new Error('Failed to fetch analytics data');
      const [ovData, trData, prData] = await Promise.all([ovRes.json(), trRes.json(), prRes.json()]);
      if (signal.aborted) return;
      setOverview(ovData);
      setTrends(trData);
      setProducts(prData);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [yearParam, period]);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchData(ctrl.signal);
    return () => ctrl.abort();
  }, [fetchData]);

  return (
    <>
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-600" />
          <span className="ml-2 text-sm text-gray-500">データ読み込み中...</span>
        </div>
      )}

      {!loading && overview && trends && products && (
        <div className="space-y-6">
          <OverviewCards data={overview as Parameters<typeof OverviewCards>[0]['data']} />
          <RevenueTrendChart
            data={trends.trends as Parameters<typeof RevenueTrendChart>[0]['data']}
            period={period}
          />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ProductMixChart
              data={(overview as { categoryBreakdown: Parameters<typeof ProductMixChart>[0]['data'] }).categoryBreakdown ?? []}
              products={(products?.products as { code: string; name: string; category: string | null; totalRevenue: number; totalQuantity: number }[]) ?? []}
            />
            <MarginAnalysisChart
              products={(products.products as Parameters<typeof MarginAnalysisChart>[0]['products'])}
            />
          </div>
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
