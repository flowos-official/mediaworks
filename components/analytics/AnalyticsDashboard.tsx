'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, FileSpreadsheet, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import DateRangeFilter from './DateRangeFilter';
import OverviewCards from './OverviewCards';
import RevenueTrendChart from './RevenueTrendChart';
import TopProductsTable from './TopProductsTable';
import ProductMixChart from './ProductMixChart';
import MarginAnalysisChart from './MarginAnalysisChart';
import MDStrategyPanel from './MDStrategyPanel';
import ProductDetailModal from './ProductDetailModal';

type Tab = 'overview' | 'products' | 'expansion';

export default function AnalyticsDashboard() {
  const tg = useTranslations('gallery');
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [selectedYears, setSelectedYears] = useState([2025, 2026]);
  const [period, setPeriod] = useState<'weekly' | 'monthly'>('weekly');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);

  // Taicho upload state
  const [showTaicho, setShowTaicho] = useState(false);
  const [taichoCode, setTaichoCode] = useState('');
  const [taichoFile, setTaichoFile] = useState<File | null>(null);
  const [taichoUploading, setTaichoUploading] = useState(false);
  const [taichoResult, setTaichoResult] = useState<string | null>(null);

  const handleTaichoUpload = async () => {
    if (!taichoFile || !taichoCode.trim()) return;
    setTaichoUploading(true);
    setTaichoResult(null);
    try {
      const form = new FormData();
      form.append('file', taichoFile);
      form.append('product_code', taichoCode.trim());
      const res = await fetch('/api/products/upload-taicho', { method: 'POST', body: form });
      const data = await res.json();
      if (res.ok) {
        setTaichoResult(`${tg('uploadSuccess')} — ${data.imagesUploaded}${tg('images')}`);
        setTaichoCode('');
        setTaichoFile(null);
      } else {
        setTaichoResult(data.error ?? tg('uploadError'));
      }
    } catch {
      setTaichoResult(tg('uploadError'));
    } finally {
      setTaichoUploading(false);
    }
  };

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

        {activeTab !== 'expansion' && (
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
      {loading && activeTab !== 'expansion' && (
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

      {/* Products tab */}
      {activeTab === 'products' && !loading && products && (
        <div className="space-y-6">
          <button
            type="button"
            onClick={() => setShowTaicho(true)}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-gray-300 rounded-xl text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
          >
            <FileSpreadsheet size={16} />
            {tg('uploadButton')} (.xlsx / .xlsm)
          </button>
          <TopProductsTable
            products={(products.products as Parameters<typeof TopProductsTable>[0]['products'])}
            onSelectProduct={setSelectedProduct}
          />
        </div>
      )}

      {/* Expansion tab — now powered by MD Strategy orchestrator */}
      {activeTab === 'expansion' && <MDStrategyPanel />}

      {/* Taicho Upload Modal */}
      {showTaicho && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => { setShowTaicho(false); setTaichoResult(null); }} />
          <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-gray-900">{tg('uploadTitle')}</h2>
              <button type="button" onClick={() => { setShowTaicho(false); setTaichoResult(null); }} className="p-1.5 hover:bg-gray-100 rounded-lg">
                <X size={18} className="text-gray-500" />
              </button>
            </div>
            <p className="text-sm text-gray-500 mb-4">{tg('uploadDescription')}</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{tg('productCode')}</label>
                <input
                  type="text"
                  value={taichoCode}
                  onChange={(e) => setTaichoCode(e.target.value)}
                  placeholder={tg('productCodePlaceholder')}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{tg('selectFile')}</label>
                <input
                  type="file"
                  accept=".xlsx,.xlsm"
                  onChange={(e) => setTaichoFile(e.target.files?.[0] ?? null)}
                  className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
              </div>
              {taichoResult && (
                <div className={`text-sm p-3 rounded-lg ${taichoResult.includes(tg('uploadSuccess')) ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                  {taichoResult}
                </div>
              )}
              <button
                type="button"
                onClick={handleTaichoUpload}
                disabled={taichoUploading || !taichoFile || !taichoCode.trim()}
                className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {taichoUploading && <Loader2 size={14} className="animate-spin" />}
                {taichoUploading ? tg('uploading') : tg('uploadButton')}
              </button>
            </div>
          </div>
        </div>
      )}

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
