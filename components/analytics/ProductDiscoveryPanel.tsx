'use client';

import { useState, useCallback, useMemo } from 'react';
import { Search, Loader2, AlertTriangle, Sparkles } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import DiscoveredProductsHero from '@/components/analytics/DiscoveredProductsHero';
import type { DiscoveryBatch, SalesStrategy } from '@/lib/md-strategy';

// MDStrategyPanel과 동일한 카테고리 리스트 사용 (일관성 유지)
const CATEGORIES = [
  '指定なし', '美容・スキンケア', '健康食品', 'キッチン用品',
  'ファッション', '生活雑貨', '電気機器', 'フィットネス', 'その他',
];

const CONTEXTS = [
  { value: 'home_shopping' as const, label: 'TV通販向け' },
  { value: 'live_commerce' as const, label: 'ライブコマース向け' },
];

export default function ProductDiscoveryPanel() {
  const [context, setContext] = useState<'home_shopping' | 'live_commerce'>('home_shopping');
  const [category, setCategory] = useState('指定なし');
  const [userGoal, setUserGoal] = useState('');
  const [priceRange, setPriceRange] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [history, setHistory] = useState<DiscoveryBatch[]>([]);
  const [analyses, setAnalyses] = useState<Record<string, SalesStrategy>>({});
  const [analyzingUrl, setAnalyzingUrl] = useState<string | null>(null);

  const latestProducts = history.length > 0 ? history[0].products : undefined;

  // Merge analyses into products for display
  const mergedProducts = useMemo(() => {
    if (!latestProducts) return undefined;
    return latestProducts.map(p =>
      p.source_url && analyses[p.source_url]
        ? { ...p, sales_strategy: analyses[p.source_url] }
        : p
    );
  }, [latestProducts, analyses]);

  const handleDiscover = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/analytics/discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context,
          category: category === '指定なし' ? undefined : category,
          userGoal: userGoal.trim() || undefined,
          priceRange: priceRange.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setSessionId(data.sessionId);
      setHistory(data.discovery_history);
      setAnalyses({});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [context, category, userGoal, priceRange]);

  const handleRediscover = useCallback(async (focus: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/analytics/discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          context,
          category: category === '指定なし' ? undefined : category,
          userGoal: userGoal.trim() || undefined,
          priceRange: priceRange.trim() || undefined,
          focus: focus || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setHistory(data.discovery_history);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId, context, category, userGoal, priceRange]);

  const handleAnalyze = useCallback(async (sourceUrl: string) => {
    if (!sessionId) return;
    setAnalyzingUrl(sourceUrl);
    try {
      const product = latestProducts?.find(p => p.source_url === sourceUrl);
      const res = await fetch('/api/analytics/discovery/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          sourceUrl,
          productName: product?.name,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setAnalyses(prev => ({ ...prev, [sourceUrl]: data.sales_strategy }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalyzingUrl(null);
    }
  }, [sessionId, latestProducts]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Search size={18} className="text-amber-600" />
        <h3 className="text-lg font-semibold text-gray-900">新商品発掘</h3>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
          AI Discovery
        </span>
      </div>

      <Card className="border-gray-200">
        <CardContent className="p-4 space-y-3">
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
              発掘の目的・方向性 (任意)
            </label>
            <textarea
              value={userGoal}
              onChange={(e) => setUserGoal(e.target.value)}
              placeholder="例: 美容家電で月商500万を目指したい / 季節商品を探している / 韓国で人気の商品を日本に"
              rows={2}
              disabled={loading}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 resize-none disabled:bg-gray-50"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1 block">
                チャネル
              </label>
              <select
                value={context}
                onChange={(e) => setContext(e.target.value as 'home_shopping' | 'live_commerce')}
                disabled={loading}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 disabled:bg-gray-50"
              >
                {CONTEXTS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1 block">
                カテゴリ
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={loading}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 disabled:bg-gray-50"
              >
                {CATEGORIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1 block">
                価格帯 (任意)
              </label>
              <input
                type="text"
                value={priceRange}
                onChange={(e) => setPriceRange(e.target.value)}
                disabled={loading}
                placeholder="例: ¥3,000-10,000"
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300 disabled:bg-gray-50"
              />
            </div>
          </div>

          <p className="text-[10px] text-gray-400">
            TV通販の販売シグナルと楽天・Web検索を組み合わせ、AIが新商品候補を選定します
          </p>

          <div className="flex items-center justify-end pt-1">
            <button
              type="button"
              onClick={handleDiscover}
              disabled={loading}
              className="flex items-center gap-2 px-5 py-2 bg-amber-600 hover:bg-amber-700 text-white text-sm font-semibold rounded-lg transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {loading ? '発掘中...' : '新商品を発掘'}
            </button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {mergedProducts && mergedProducts.length > 0 && (
        <DiscoveredProductsHero
          products={mergedProducts}
          contextLabel={context === 'live_commerce' ? 'ライブコマース' : 'TV通販'}
          history={history}
          onRediscover={handleRediscover}
          rediscovering={loading}
          onAnalyze={handleAnalyze}
          analyzingUrl={analyzingUrl}
        />
      )}
    </div>
  );
}
