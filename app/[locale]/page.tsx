'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Navbar from '@/components/Navbar';
import FileUpload from '@/components/FileUpload';
import ProductList from '@/components/ProductList';
import { Sparkles, Wand2, Loader2, TrendingUp, ExternalLink } from 'lucide-react';
import type { ProductRecommendation } from '@/app/api/recommend/route';

const CATEGORIES = ['美容・スキンケア', '健康食品', 'キッチン用品', 'ファッション', '生活雑貨', '電気機器', 'フィットネス', 'その他'];
const MARKETS = ['日本全国', '40-60代女性', '20-30代女性', '男女共用'];

function AIRecommendSection() {
  const [category, setCategory] = useState('美容・スキンケア');
  const [targetMarket, setTargetMarket] = useState('40-60代女性');
  const [priceRange, setPriceRange] = useState('');
  const [loading, setLoading] = useState(false);
  const [recs, setRecs] = useState<ProductRecommendation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setRecs([]);
    try {
      const res = await fetch('/api/recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, targetMarket, priceRange: priceRange || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRecs(data.recommendations ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const scoreColor = (score: number) =>
    score >= 80 ? 'text-green-700 bg-green-50' :
    score >= 60 ? 'text-blue-700 bg-blue-50' :
    score >= 40 ? 'text-yellow-700 bg-yellow-50' : 'text-red-700 bg-red-50';

  return (
    <section className="mb-16">
      <div className="flex items-center gap-2 mb-6">
        <Wand2 size={20} className="text-purple-600" />
        <h2 className="text-xl font-semibold text-gray-900">AI 제품 추천</h2>
        <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">Gemini 기반</span>
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-gray-200 rounded-2xl p-5 mb-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">카테고리</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
            >
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">타겟 시장</label>
            <select
              value={targetMarket}
              onChange={(e) => setTargetMarket(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
            >
              {MARKETS.map((m) => <option key={m}>{m}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">가격대 (선택)</label>
            <input
              type="text"
              value={priceRange}
              onChange={(e) => setPriceRange(e.target.value)}
              placeholder="예: ¥3,000-8,000"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
            />
          </div>
        </div>
        <button
          type="button"
          onClick={handleGenerate}
          disabled={loading}
          className="flex items-center gap-2 px-5 py-2.5 bg-purple-600 hover:bg-purple-700 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-60"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
          {loading ? '분석 중...' : 'AI 추천 받기'}
        </button>
        {error && <p className="text-red-500 text-sm mt-3">{error}</p>}
      </div>

      {/* Results */}
      {recs.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {recs.map((rec, i) => (
            <div key={i} className="bg-white border border-gray-200 rounded-2xl p-5 hover:shadow-md transition-shadow">
              <div className="flex items-start justify-between mb-3">
                <h3 className="font-semibold text-sm leading-tight flex-1">{rec.name}</h3>
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ml-2 shrink-0 ${scoreColor(rec.japan_fit_score)}`}>
                  {rec.japan_fit_score}
                </span>
              </div>
              <p className="text-xs text-gray-600 mb-3 leading-relaxed">{rec.reason}</p>
              <div className="space-y-1.5 text-[11px] text-gray-500 mb-3">
                <div className="flex items-center gap-1.5">
                  <TrendingUp size={11} />
                  <span>수요: {rec.estimated_demand}</span>
                </div>
                <div className="flex justify-between">
                  <span>공급: {rec.supply_source}</span>
                  <span className="font-semibold text-gray-700">{rec.estimated_price_jpy}</span>
                </div>
              </div>
              {rec.sources && rec.sources.length > 0 && (
                <div className="border-t border-gray-100 pt-2.5 space-y-1">
                  {rec.sources.map((src, si) => (
                    <a
                      key={si}
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-[10px] text-blue-500 hover:text-blue-700 hover:underline truncate"
                    >
                      <ExternalLink size={9} className="shrink-0" />
                      <span className="truncate">{src.title || src.url}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function HomePage() {
  const t = useTranslations('home');
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [activeTab, setActiveTab] = useState<'upload' | 'recommend'>('upload');

  const handleUploadComplete = () => {
    setRefreshTrigger((n) => n + 1);
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Hero */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 bg-blue-50 text-blue-700 text-sm font-medium px-4 py-2 rounded-full mb-4">
            <Sparkles size={14} />
            AI-Powered Research
          </div>
          <h1 className="text-4xl font-bold text-gray-900 mb-3">{t('title')}</h1>
          <p className="text-lg text-gray-500 max-w-2xl mx-auto">{t('description')}</p>
        </div>

        {/* Tab switcher */}
        <div className="flex justify-center mb-10">
          <div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-xl shadow-sm">
            {(['upload', 'recommend'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg transition-all ${
                  activeTab === tab
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                {tab === 'upload' ? <Sparkles size={14} /> : <Wand2 size={14} />}
                {tab === 'upload' ? '제품 분석' : 'AI 추천'}
              </button>
            ))}
          </div>
        </div>

        {activeTab === 'upload' && (
          <>
            {/* Upload */}
            <div className="max-w-2xl mx-auto mb-16">
              <FileUpload onUploadComplete={handleUploadComplete} />
            </div>
            {/* Product List */}
            <section>
              <h2 className="text-xl font-semibold text-gray-900 mb-6">{t('recentProducts')}</h2>
              <ProductList refreshTrigger={refreshTrigger} />
            </section>
          </>
        )}

        {activeTab === 'recommend' && <AIRecommendSection />}
      </main>
    </div>
  );
}
