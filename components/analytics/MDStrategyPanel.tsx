'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Rocket, AlertTriangle, Target, Database, ArrowLeft } from 'lucide-react';
import {
	BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import StrategyProgress from './md-strategy/StrategyProgress';
import StrategyHistory from './md-strategy/StrategyHistory';
import ProductSelectionSection from './md-strategy/ProductSelectionSection';
import type {
	SkillName,
	ParsedGoal,
	ProductSelectionOutput,
	ChannelStrategyOutput,
	PricingMarginOutput,
	MarketingExecutionOutput,
	FinancialProjectionOutput,
	RiskContingencyOutput,
} from '@/lib/md-strategy';

import dynamic from 'next/dynamic';
const ChannelStrategySection = dynamic(() => import('./md-strategy/ChannelStrategySection'), { ssr: false });
const PricingMarginSection = dynamic(() => import('./md-strategy/PricingMarginSection'), { ssr: false });
const MarketingExecutionSection = dynamic(() => import('./md-strategy/MarketingExecutionSection'), { ssr: false });
const FinancialProjectionSection = dynamic(() => import('./md-strategy/FinancialProjectionSection'), { ssr: false });
const RiskContingencySection = dynamic(() => import('./md-strategy/RiskContingencySection'), { ssr: false });
const StrategyPdfDownload = dynamic(() => import('./md-strategy/StrategyPdfDownload'), { ssr: false });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatYen(v: number): string {
	if (v >= 100_000_000) return `¥${(v / 100_000_000).toFixed(1)}億`;
	if (v >= 10_000) return `¥${Math.round(v / 10_000)}万`;
	return `¥${v.toLocaleString()}`;
}

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

// ---------------------------------------------------------------------------
// DataPreview
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
// Shared: Skill results renderer
// ---------------------------------------------------------------------------

function SkillResultsView({ results, generatedAt, onBack }: {
	results: SkillResults;
	generatedAt?: string | null;
	onBack: () => void;
}) {
	const hasAny = Object.keys(results).length > 0;
	if (!hasAny) return null;

	return (
		<>
			{/* Back button */}
			<button type="button" onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors mb-2">
				<ArrowLeft size={14} />
				一覧に戻る
			</button>

			<div id="md-strategy-content" className="space-y-8">
				{results.product_selection && <ProductSelectionSection data={results.product_selection} />}
				{results.channel_strategy && <ChannelStrategySection data={results.channel_strategy} />}
				{results.pricing_margin && <PricingMarginSection data={results.pricing_margin} />}
				{results.marketing_execution && <MarketingExecutionSection data={results.marketing_execution} />}
				{results.financial_projection && <FinancialProjectionSection data={results.financial_projection} />}
				{results.risk_contingency && <RiskContingencySection data={results.risk_contingency} />}
			</div>

			{generatedAt && (
				<div className="flex items-center justify-between">
					<p className="text-[10px] text-gray-400">
						生成: {new Date(generatedAt).toLocaleString('ja-JP')}
					</p>
					<StrategyPdfDownload />
				</div>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES = ['指定なし', '美容・スキンケア', '健康食品', 'キッチン用品', 'ファッション', '生活雑貨', '電気機器', 'フィットネス', 'その他'];
const MARKETS = ['指定なし', '日本全国', '40-60代女性', '20-30代女性', '男女共用'];

type SkillStatus = 'pending' | 'running' | 'complete' | 'error';

interface SkillResults {
	goal_analysis?: ParsedGoal | null;
	product_selection?: ProductSelectionOutput;
	channel_strategy?: ChannelStrategyOutput;
	pricing_margin?: PricingMarginOutput;
	marketing_execution?: MarketingExecutionOutput;
	financial_projection?: FinancialProjectionOutput;
	risk_contingency?: RiskContingencyOutput;
}

const INITIAL_STATUSES: Record<SkillName, SkillStatus> = {
	goal_analysis: 'pending',
	product_selection: 'pending',
	channel_strategy: 'pending',
	pricing_margin: 'pending',
	marketing_execution: 'pending',
	financial_projection: 'pending',
	risk_contingency: 'pending',
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function MDStrategyPanel() {
	// View mode: form (input + history), generating (SSE in progress + results), saved (loaded from DB)
	const [viewMode, setViewMode] = useState<'form' | 'generating' | 'saved'>('form');

	// Input state
	const [userGoal, setUserGoal] = useState('');
	const [category, setCategory] = useState('指定なし');
	const [targetMarket, setTargetMarket] = useState('指定なし');
	const [priceRange, setPriceRange] = useState('');

	// Generation state
	const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
	const [dataFetchStatus, setDataFetchStatus] = useState<'pending' | 'running' | 'complete'>('pending');
	const [skillStatuses, setSkillStatuses] = useState<Record<SkillName, SkillStatus>>({ ...INITIAL_STATUSES });
	const [skillResults, setSkillResults] = useState<SkillResults>({});
	const [error, setError] = useState<string | null>(null);
	const [generatedAt, setGeneratedAt] = useState<string | null>(null);

	// Saved strategy view state
	const [savedResults, setSavedResults] = useState<SkillResults>({});
	const [savedAt, setSavedAt] = useState<string | null>(null);
	const [loadingStrategy, setLoadingStrategy] = useState(false);

	// History refresh trigger
	const [historyRefresh, setHistoryRefresh] = useState(0);

	// --- Generate new strategy ---
	const handleGenerate = useCallback(async () => {
		setViewMode('generating');
		setStatus('running');
		setError(null);
		setSkillResults({});
		setSkillStatuses({ ...INITIAL_STATUSES });
		setDataFetchStatus('pending');
		setGeneratedAt(null);

		try {
			const res = await fetch('/api/analytics/md-strategy', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					userGoal: userGoal || undefined,
					category: category !== '指定なし' ? category : undefined,
					targetMarket: targetMarket !== '指定なし' ? targetMarket : undefined,
					priceRange: priceRange || undefined,
				}),
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}

			const reader = res.body?.getReader();
			if (!reader) throw new Error('No response body');

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				let eventType = '';
				for (const line of lines) {
					if (line.startsWith('event: ')) {
						eventType = line.slice(7).trim();
					} else if (line.startsWith('data: ') && eventType) {
						try {
							const payload = JSON.parse(line.slice(6));
							handleSSEEvent(eventType, payload);
						} catch {
							// skip
						}
						eventType = '';
					}
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatus('error');
		}
	}, [userGoal, category, targetMarket, priceRange]);

	const handleSSEEvent = (event: string, payload: Record<string, unknown>) => {
		switch (event) {
			case 'progress': {
				const skill = payload.skill as string;
				if (skill === 'data_fetch') {
					setDataFetchStatus(payload.status as 'running' | 'complete');
				} else {
					setSkillStatuses((prev) => ({ ...prev, [skill]: 'running' }));
				}
				break;
			}
			case 'skill_result': {
				const skill = payload.skill as SkillName;
				setSkillStatuses((prev) => ({ ...prev, [skill]: 'complete' }));
				setSkillResults((prev) => ({ ...prev, [skill]: payload.data }));
				break;
			}
			case 'skill_error': {
				const skill = payload.skill as SkillName;
				setSkillStatuses((prev) => ({ ...prev, [skill]: 'error' }));
				break;
			}
			case 'complete':
				setStatus('complete');
				setGeneratedAt(payload.generatedAt as string);
				setHistoryRefresh((n) => n + 1); // refresh history list
				break;
			case 'error':
				setError(payload.message as string);
				setStatus('error');
				break;
		}
	};

	// --- Load saved strategy ---
	const handleViewSaved = async (id: string) => {
		setLoadingStrategy(true);
		setError(null);
		try {
			const res = await fetch(`/api/analytics/md-strategy/${id}`);
			if (!res.ok) throw new Error('Failed to load strategy');
			const data = await res.json();

			setSavedResults({
				goal_analysis: data.goal_analysis ?? undefined,
				product_selection: data.product_selection ?? undefined,
				channel_strategy: data.channel_strategy ?? undefined,
				pricing_margin: data.pricing_margin ?? undefined,
				marketing_execution: data.marketing_execution ?? undefined,
				financial_projection: data.financial_projection ?? undefined,
				risk_contingency: data.risk_contingency ?? undefined,
			});
			setSavedAt(data.created_at);
			setViewMode('saved');
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingStrategy(false);
		}
	};

	// --- Back to form ---
	const handleBackToForm = () => {
		setViewMode('form');
		setStatus('idle');
		setSkillResults({});
		setSavedResults({});
		setSavedAt(null);
		setGeneratedAt(null);
	};

	const isRunning = status === 'running';
	// Check if we have any renderable skill results (excluding goal_analysis which has no UI section)
	const hasGeneratedResults = !!(
		skillResults.product_selection ||
		skillResults.channel_strategy ||
		skillResults.pricing_margin ||
		skillResults.marketing_execution ||
		skillResults.financial_projection ||
		skillResults.risk_contingency
	);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center gap-2">
				<Target size={18} className="text-blue-600" />
				<h3 className="text-lg font-semibold text-gray-900">チャネル拡大戦略</h3>
				<span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">7-Skill AI</span>
			</div>

			{/* === FORM VIEW === */}
			{viewMode === 'form' && (
				<>
					<Card className="border-gray-200">
						<CardContent className="p-4 space-y-3">
							<div>
								<label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
									拡大の目標・方向性 (任意)
								</label>
								<textarea
									value={userGoal}
									onChange={(e) => setUserGoal(e.target.value)}
									placeholder="例: 楽天・Amazonで月商1000万を目指したい / TikTokで若年層にリーチしたい / 韓国Coupangへの越境ECを検討中"
									rows={3}
									className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none"
								/>
							</div>

							<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
								<div>
									<label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1 block">カテゴリ</label>
									<select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300">
										{CATEGORIES.map((c) => <option key={c}>{c}</option>)}
									</select>
								</div>
								<div>
									<label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1 block">ターゲット市場</label>
									<select value={targetMarket} onChange={(e) => setTargetMarket(e.target.value)} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300">
										{MARKETS.map((m) => <option key={m}>{m}</option>)}
									</select>
								</div>
								<div>
									<label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1 block">価格帯（任意）</label>
									<input type="text" value={priceRange} onChange={(e) => setPriceRange(e.target.value)} placeholder="例: ¥3,000-8,000" className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300" />
								</div>
							</div>
							<p className="text-[10px] text-gray-400">
								カテゴリとターゲット市場を指定すると、AI推薦商品も戦略に組み込まれます（指定なしでも分析可能）
							</p>

							<div className="flex items-center justify-between pt-1">
								<p className="text-[10px] text-gray-400">
									7つの専門スキル（目標分析→商品選定→チャネル戦略→価格設計→マーケ計画→収益予測→リスク対策）が順次分析します
								</p>
								<button
									type="button"
									onClick={handleGenerate}
									className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors shrink-0"
								>
									<Rocket size={14} />
									拡大戦略を分析
								</button>
							</div>
						</CardContent>
					</Card>

					<DataPreview />

					{/* Strategy history */}
					<StrategyHistory onView={handleViewSaved} refreshKey={historyRefresh} />

					{/* Loading saved strategy */}
					{loadingStrategy && (
						<div className="flex items-center gap-2 py-4 text-sm text-gray-500">
							<Loader2 size={14} className="animate-spin" />
							戦略データを読み込み中...
						</div>
					)}
				</>
			)}

			{/* === GENERATING VIEW === */}
			{viewMode === 'generating' && (
				<>
					{/* Error */}
					{error && (
						<div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
							<AlertTriangle size={14} />
							{error}
							<button type="button" onClick={handleBackToForm} className="ml-auto text-xs underline">戻る</button>
						</div>
					)}

					{/* Progress */}
					{isRunning && (
						<StrategyProgress skillStatuses={skillStatuses} dataFetchStatus={dataFetchStatus} />
					)}

					{/* Results (progressive + complete) */}
					{hasGeneratedResults && (
						<SkillResultsView
							results={skillResults}
							generatedAt={generatedAt}
							onBack={handleBackToForm}
						/>
					)}
				</>
			)}

			{/* === SAVED VIEW === */}
			{viewMode === 'saved' && (
				<SkillResultsView
					results={savedResults}
					generatedAt={savedAt}
					onBack={handleBackToForm}
				/>
			)}
		</div>
	);
}
