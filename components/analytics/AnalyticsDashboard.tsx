'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import DateRangeFilter from './DateRangeFilter';
import OverviewCards from './OverviewCards';
import RevenueTrendChart from './RevenueTrendChart';
import TopProductsTable from './TopProductsTable';
import ProductMixChart from './ProductMixChart';
import MarginAnalysisChart from './MarginAnalysisChart';
import ExpansionAnalysis from './ExpansionAnalysis';
import MDStrategyPanel from './MDStrategyPanel';
import ProductDetailModal from './ProductDetailModal';

type Tab = 'overview' | 'products' | 'expansion' | 'md-strategy';

export default function AnalyticsDashboard() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [selectedYears, setSelectedYears] = useState([2025, 2026]);
  const [period, setPeriod] = useState<'weekly' | 'monthly'>('weekly');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);

  // Data states
  const [overview, setOverview] = useState<Record<string, unknown> | null>(null);
  const [trends, setTrends] = useState<{ period: string; trends: unknown[] } | null>(null);
  const [products, setProducts] = useState<{ products: unknown[]; total: number } | null>(null);

  const yearParam = selectedYears.join(',');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ovRes, trRes, prRes] = await Promise.all([
        fetch(`/api/analytics/overview?year=${yearParam}`),
        fetch(`/api/analytics/trends?year=${yearParam}&period=${period}`),
        fetch(`/api/analytics/products?year=${yearParam}&limit=500`),
      ]);

      if (!ovRes.ok || !trRes.ok || !prRes.ok) {
        throw new Error('Failed to fetch analytics data');
      }

      const [ovData, trData, prData] = await Promise.all([
        ovRes.json(),
        trRes.json(),
        prRes.json(),
      ]);

      setOverview(ovData);
      setTrends(trData);
      setProducts(prData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [yearParam, period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const tabs: { key: Tab; label: string }[] = [
    { key: 'overview', label: '概要' },
    { key: 'products', label: '商品分析' },
    { key: 'expansion', label: '拡大戦略' },
    { key: 'md-strategy', label: 'MD戦略' },
  ];

  return (
    <div className="space-y-6">
      {/* Tab bar + filters */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-xl shadow-sm">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                activeTab === tab.key
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab !== 'expansion' && activeTab !== 'md-strategy' && (
          <DateRangeFilter
            years={[2025, 2026]}
            selectedYears={selectedYears}
            period={period}
            onYearsChange={setSelectedYears}
            onPeriodChange={setPeriod}
          />
        )}
      </div>

      {/* Error */}
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && activeTab !== 'expansion' && activeTab !== 'md-strategy' && (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-600" />
          <span className="ml-2 text-sm text-gray-500">データ読み込み中...</span>
        </div>
      )}

      {/* Overview tab */}
      {activeTab === 'overview' && !loading && overview && trends && products && (
        <div className="space-y-6">
          <OverviewCards data={overview as Parameters<typeof OverviewCards>[0]['data']} />
          <RevenueTrendChart
            data={trends.trends as Parameters<typeof RevenueTrendChart>[0]['data']}
            period={period}
          />
          <TopProductsTable
            products={(products.products as Parameters<typeof TopProductsTable>[0]['products'])}
            onSelectProduct={setSelectedProduct}
          />
        </div>
      )}

      {/* Products tab */}
      {activeTab === 'products' && !loading && overview && products && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ProductMixChart
              data={(overview as { categoryBreakdown: Parameters<typeof ProductMixChart>[0]['data'] }).categoryBreakdown ?? []}
            />
            <MarginAnalysisChart
              products={(products.products as Parameters<typeof MarginAnalysisChart>[0]['products'])}
            />
          </div>
          <TopProductsTable
            products={(products.products as Parameters<typeof TopProductsTable>[0]['products'])}
            onSelectProduct={setSelectedProduct}
          />
        </div>
      )}

      {/* Expansion tab */}
      {activeTab === 'expansion' && <ExpansionAnalysis />}

      {/* MD Strategy tab */}
      {activeTab === 'md-strategy' && <MDStrategyPanel />}

      {/* Product detail modal */}
      {selectedProduct && (
        <ProductDetailModal
          productCode={selectedProduct}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </div>
  );
}
