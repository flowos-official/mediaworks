'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Rocket, AlertTriangle, Database, TrendingUp, Target } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { ExpansionAnalysisResult, RecommendedProduct } from '@/lib/gemini';

type TopProduct = {
  code: string;
  name: string;
  category: string | null;
  totalRevenue: number;
  totalProfit: number;
  totalQuantity: number;
  marginRate: number;
  avgWeeklyQty: number;
  weekCount: number;
};

type ApiResponse = {
  analysis: ExpansionAnalysisResult;
  topProducts: TopProduct[];
  categorySummary: Record<string, { revenue: number; quantity: number }>;
  generatedAt: string;
};

function formatYen(v: number): string {
  if (v >= 100_000_000) return `¥${(v / 100_000_000).toFixed(1)}億`;
  if (v >= 10_000) return `¥${Math.round(v / 10_000)}万`;
  return `¥${v.toLocaleString()}`;
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-green-700 bg-green-50';
  if (score >= 60) return 'text-blue-700 bg-blue-50';
  if (score >= 40) return 'text-yellow-700 bg-yellow-50';
  return 'text-red-700 bg-red-50';
}

// ---------------------------------------------------------------------------
// Sub: Data Preview (shown before analysis)
// ---------------------------------------------------------------------------

function DataPreview() {
  const [overview, setOverview] = useState<{
    totalRevenue: number;
    totalProfit: number;
    marginRate: number;
    uniqueProducts: number;
    weekCount: number;
    categoryBreakdown: Array<{ category: string; revenue: number; quantity: number }>;
  } | null>(null);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);

  useEffect(() => {
    Promise.all([
      fetch('/api/analytics/overview?year=2025,2026').then((r) => r.json()),
      fetch('/api/analytics/products?year=2025,2026&limit=5').then((r) => r.json()),
    ]).then(([ov, pr]) => {
      setOverview(ov);
      setTopProducts(pr.products ?? []);
    }).catch(() => {});
  }, []);

  if (!overview) return null;

  const catData = (overview.categoryBreakdown ?? []).slice(0, 8).map((c) => ({
    name: c.category,
    revenue: Math.round(c.revenue / 10000),
  }));

  return (
    <Card className="border-blue-200 bg-blue-50/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-1.5 text-blue-700">
          <Database size={14} /> 分析データプレビュー
        </CardTitle>
        <p className="text-[10px] text-gray-500">このデータを基にAIが拡大戦略を分析します</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* KPI mini row */}
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: '総売上', value: formatYen(overview.totalRevenue) },
            { label: '粗利率', value: `${overview.marginRate}%` },
            { label: '商品数', value: `${overview.uniqueProducts}` },
            { label: '集計週数', value: `${overview.weekCount}週` },
          ].map((kpi) => (
            <div key={kpi.label} className="bg-white rounded-lg p-2 text-center border border-blue-100">
              <div className="text-[9px] text-gray-500">{kpi.label}</div>
              <div className="text-sm font-bold text-gray-900">{kpi.value}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Top 5 products mini table */}
          <div>
            <span className="text-[10px] font-semibold text-gray-500 uppercase">売上TOP5</span>
            <div className="mt-1 space-y-1">
              {topProducts.map((p, i) => (
                <div key={p.code} className="flex items-center gap-2 text-xs bg-white rounded px-2 py-1 border border-gray-100">
                  <span className="text-gray-400 font-mono w-4">{i + 1}</span>
                  <span className="text-gray-800 truncate flex-1">{p.name}</span>
                  <span className="font-mono text-gray-600 shrink-0">{formatYen(p.totalRevenue)}</span>
                  <span className="font-mono text-gray-500 shrink-0 w-12 text-right">{p.marginRate}%</span>
                </div>
              ))}
            </div>
          </div>

          {/* Category bar chart */}
          <div>
            <span className="text-[10px] font-semibold text-gray-500 uppercase">カテゴリ別売上 (万円)</span>
            <div className="h-36 mt-1">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={catData} layout="vertical" margin={{ top: 0, right: 5, left: 0, bottom: 0 }}>
                  <XAxis type="number" tick={{ fontSize: 9, fill: '#9ca3af' }} tickFormatter={(v) => `${v}万`} />
                  <YAxis type="category" dataKey="name" width={70} tick={{ fontSize: 9, fill: '#6b7280' }} />
                  <Tooltip formatter={(v: unknown) => [`${Number(v)}万円`, '売上']} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                  <Bar dataKey="revenue" fill="#3b82f6" radius={[0, 4, 4, 0]} barSize={12} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sub: Evidence Section
// ---------------------------------------------------------------------------

function EvidenceSection({ topProducts, categorySummary }: {
  topProducts: TopProduct[];
  categorySummary: Record<string, { revenue: number; quantity: number }>;
}) {
  const catData = Object.entries(categorySummary)
    .sort(([, a], [, b]) => b.revenue - a.revenue)
    .slice(0, 10)
    .map(([name, d]) => ({ name, revenue: Math.round(d.revenue / 10000) }));

  return (
    <Card className="border-emerald-200 bg-emerald-50/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-1.5 text-emerald-700">
          <Database size={14} /> データ根拠 — TV通販実績
        </CardTitle>
        <p className="text-[10px] text-gray-500">以下の販売実績データを基に上記の分析が導出されました</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Top products table */}
        <div>
          <span className="text-[10px] font-semibold text-gray-500 uppercase">上位商品実績</span>
          <div className="overflow-x-auto mt-1">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-emerald-100 text-gray-500">
                  <th className="text-left px-2 py-1">#</th>
                  <th className="text-left px-2 py-1">商品名</th>
                  <th className="text-left px-2 py-1">カテゴリ</th>
                  <th className="text-right px-2 py-1">総売上</th>
                  <th className="text-right px-2 py-1">粗利率</th>
                  <th className="text-right px-2 py-1">週平均</th>
                  <th className="text-right px-2 py-1">販売週</th>
                </tr>
              </thead>
              <tbody>
                {topProducts.slice(0, 10).map((p, i) => (
                  <tr key={p.code} className="border-b border-gray-50">
                    <td className="px-2 py-1 text-gray-400 font-mono">{i + 1}</td>
                    <td className="px-2 py-1 text-gray-800 font-medium max-w-[160px] truncate">{p.name}</td>
                    <td className="px-2 py-1">
                      {p.category && <span className="text-[9px] px-1 py-0.5 rounded bg-gray-100">{p.category}</span>}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">{formatYen(p.totalRevenue)}</td>
                    <td className="px-2 py-1 text-right font-mono">{p.marginRate}%</td>
                    <td className="px-2 py-1 text-right font-mono">{p.avgWeeklyQty}個</td>
                    <td className="px-2 py-1 text-right font-mono text-gray-500">{p.weekCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Category chart */}
        <div>
          <span className="text-[10px] font-semibold text-gray-500 uppercase">カテゴリ別売上構成 (万円)</span>
          <div className="h-40 mt-1">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={catData} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 9, fill: '#9ca3af' }} tickFormatter={(v) => `${v}万`} />
                <YAxis type="category" dataKey="name" width={75} tick={{ fontSize: 9, fill: '#6b7280' }} />
                <Tooltip formatter={(v: unknown) => [`${Number(v)}万円`, '売上']} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
                <Bar dataKey="revenue" fill="#10b981" radius={[0, 4, 4, 0]} barSize={14} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function ExpansionAnalysis() {
  const [userGoal, setUserGoal] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/analytics/expansion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userGoal: userGoal || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const analysis = result?.analysis;

  return (
    <div className="space-y-6">
      {/* ===== STEP 1: Input ===== */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <Target size={18} className="text-blue-600" />
          <h3 className="text-lg font-semibold text-gray-900">チャネル拡大戦略</h3>
        </div>

        {/* User goal textarea */}
        <Card className="border-gray-200 mb-4">
          <CardContent className="p-4">
            <label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">
              拡大の目標・方向性 (任意)
            </label>
            <textarea
              value={userGoal}
              onChange={(e) => setUserGoal(e.target.value)}
              placeholder="例: 楽天やAmazonでEC販売を始めたい / 韓国市場に進出したい / 若い世代向けにTikTokで展開したい / 自社ECサイトを立ち上げたい"
              rows={3}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none"
            />
            <div className="flex items-center justify-between mt-3">
              <p className="text-[10px] text-gray-400">
                目標を入力すると、その方向に特化した分析結果が得られます
              </p>
              {loading ? (
                <button
                  type="button"
                  disabled
                  className="flex items-center gap-2 px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-lg opacity-60"
                >
                  <Loader2 size={14} className="animate-spin" />
                  AI分析中...
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleAnalyze}
                  className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  <Rocket size={14} />
                  拡大戦略を分析
                </button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Data preview (before analysis) */}
        {!result && !loading && <DataPreview />}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex flex-col items-center justify-center py-12 space-y-3">
          <Loader2 size={32} className="animate-spin text-blue-600" />
          <p className="text-sm text-gray-500">TV通販の販売実績データをAIが分析中...</p>
          <p className="text-[10px] text-gray-400">161商品 × 45週間のデータを基に最適なチャネル戦略を導出しています</p>
        </div>
      )}

      {/* ===== STEP 3: Results ===== */}
      {analysis && result && (
        <>
          {/* (A) Evidence */}
          <EvidenceSection
            topProducts={result.topProducts}
            categorySummary={result.categorySummary}
          />

          {/* Summary */}
          <Card className="border-blue-200 bg-blue-50/30">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-semibold text-blue-700">総合分析</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-gray-700 leading-relaxed whitespace-pre-line">
                {analysis.summary}
              </p>
            </CardContent>
          </Card>

          {/* (B) Channel recommendations */}
          <div>
            <h4 className="text-sm font-semibold text-gray-800 mb-3 flex items-center gap-1.5">
              <TrendingUp size={14} /> チャネル別分析
            </h4>
            <div className="space-y-6">
              {analysis.channel_recommendations
                .sort((a, b) => b.fit_score - a.fit_score)
                .map((ch) => {
                  // Fuzzy match strategy/risk by partial channel name inclusion
                  const strategy = analysis.entry_strategy.find((s) =>
                    s.channel.includes(ch.channel) || ch.channel.includes(s.channel) ||
                    s.channel.split(/[/／・]/).some((part) => ch.channel.includes(part.trim())));
                  const risk = analysis.risk_assessment.find((r) =>
                    r.channel.includes(ch.channel) || ch.channel.includes(r.channel) ||
                    r.channel.split(/[/／・]/).some((part) => ch.channel.includes(part.trim())));

                  return (
                    <Card key={ch.channel} className="border-gray-200">
                      {/* Channel Header */}
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <CardTitle className="text-base font-bold">{ch.channel}</CardTitle>
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-bold px-3 py-1 rounded-full ${scoreColor(ch.fit_score)}`}>
                              適合度 {ch.fit_score}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-500 mt-1">
                          {ch.estimated_market_size && <span>市場規模: {ch.estimated_market_size}</span>}
                          {ch.entry_difficulty && <span>参入難易度: {ch.entry_difficulty}</span>}
                        </div>
                      </CardHeader>

                      <CardContent className="pt-0 space-y-4">
                        {/* Why this channel */}
                        <div>
                          <span className="text-[10px] font-semibold text-gray-500 uppercase block mb-1">なぜこのチャネルか</span>
                          <p className="text-sm text-gray-700 leading-relaxed">{ch.reasoning}</p>
                        </div>

                        {/* Recommended products with evidence */}
                        {ch.recommended_products && ch.recommended_products.length > 0 && (
                          <div>
                            <span className="text-[10px] font-semibold text-gray-500 uppercase block mb-1.5">推奨商品 — TV通販実績に基づく根拠</span>
                            <div className="space-y-2">
                              {ch.recommended_products.map((p: RecommendedProduct | string, i: number) => {
                                if (typeof p === 'string') {
                                  return (
                                    <div key={i} className="bg-blue-50 rounded-lg px-3 py-2 text-xs">
                                      <span className="font-medium text-gray-800">{p}</span>
                                    </div>
                                  );
                                }
                                return (
                                  <div key={i} className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2.5">
                                    <div className="flex items-center justify-between">
                                      <span className="font-semibold text-sm text-gray-900">{p.name}</span>
                                    </div>
                                    <div className="flex items-center gap-3 mt-1.5 text-xs">
                                      <span className="bg-white px-2 py-0.5 rounded border border-blue-200 font-mono text-blue-700">TV売上 {p.tv_revenue}</span>
                                      <span className="bg-white px-2 py-0.5 rounded border border-green-200 font-mono text-green-700">粗利率 {p.margin}</span>
                                      <span className="bg-white px-2 py-0.5 rounded border border-orange-200 font-mono text-orange-700">週平均 {p.weekly_avg}個</span>
                                    </div>
                                    {p.fit_reason && (
                                      <p className="text-xs text-gray-600 mt-1.5 leading-relaxed">→ {p.fit_reason}</p>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Entry strategy — always visible */}
                        {strategy && (
                          <div className="border-t border-gray-100 pt-3">
                            <span className="text-[10px] font-semibold text-gray-500 uppercase block mb-1.5">具体的な参入ステップ</span>
                            <div className="flex gap-3 mb-2 text-xs">
                              <span className="bg-gray-100 px-2 py-0.5 rounded font-medium">期間: {strategy.timeline}</span>
                              <span className="bg-gray-100 px-2 py-0.5 rounded font-medium">初期投資: {strategy.initial_investment}</span>
                            </div>
                            <ol className="space-y-1">
                              {strategy.steps.map((step, i) => (
                                <li key={i} className="text-xs text-gray-700 flex gap-2">
                                  <span className="bg-blue-600 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] shrink-0 mt-0.5">{i + 1}</span>
                                  {step}
                                </li>
                              ))}
                            </ol>
                          </div>
                        )}

                        {/* Risk — always visible */}
                        {risk && (
                          <div className="bg-orange-50/50 border border-orange-100 rounded-lg p-3">
                            <span className="text-[10px] font-semibold text-orange-600 uppercase flex items-center gap-1 mb-1">
                              <AlertTriangle size={10} /> リスクと対策
                            </span>
                            <ul className="space-y-0.5 mb-2">
                              {risk.risks.map((r, i) => (
                                <li key={i} className="text-xs text-gray-700">• {r}</li>
                              ))}
                            </ul>
                            <p className="text-xs text-gray-600 bg-white rounded px-2 py-1.5 border border-orange-100">
                              <span className="font-medium text-orange-700">対策:</span> {risk.mitigation}
                            </p>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
            </div>
          </div>

          {/* (C) Product-channel fit */}
          {analysis.product_channel_fit.length > 0 && (
            <Card className="border-gray-200">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold">商品×チャネル適合マップ</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {analysis.product_channel_fit.map((pcf) => (
                    <div key={pcf.product} className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-0">
                      <span className="text-xs font-medium text-gray-900 min-w-[140px] shrink-0">
                        {pcf.product}
                      </span>
                      <div className="flex flex-wrap gap-1">
                        {pcf.best_channels.map((ch) => (
                          <Badge key={ch} variant="secondary" className="text-[9px]">{ch}</Badge>
                        ))}
                      </div>
                      <span className="text-[10px] text-gray-500 ml-auto max-w-[200px]">{pcf.reasoning}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          <p className="text-[10px] text-gray-400 text-right">
            生成: {result.generatedAt ? new Date(result.generatedAt).toLocaleString('ja-JP') : ''}
            {userGoal && ` | 目標: "${userGoal.slice(0, 30)}${userGoal.length > 30 ? '...' : ''}"`}
          </p>
        </>
      )}
    </div>
  );
}
