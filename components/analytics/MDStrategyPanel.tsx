'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Loader2, Rocket, AlertTriangle, Target, Database, ArrowLeft, Sparkles } from 'lucide-react';
import {
	BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import StrategyProgress from './md-strategy/StrategyProgress';
import StrategyHistory from './md-strategy/StrategyHistory';
import ProductSelectionSection from './md-strategy/ProductSelectionSection';
import DiscoveredProductsHero from './DiscoveredProductsHero';
import { localePath } from '@/lib/i18n/locale-path';
import { summarizeMdStrategyEvidence } from '@/lib/recommendation/strategy-evidence';
import type {
	SkillName,
	ParsedGoal,
	ProductSelectionOutput,
	ChannelStrategyOutput,
	PricingMarginOutput,
	MarketingExecutionOutput,
	FinancialProjectionOutput,
	RiskContingencyOutput,
	DiscoveredProduct,
} from '@/lib/md-strategy';

import dynamic from 'next/dynamic';
const ChannelStrategySection = dynamic(() => import('./md-strategy/ChannelStrategySection'), { ssr: false });
const PricingMarginSection = dynamic(() => import('./md-strategy/PricingMarginSection'), { ssr: false });
const MarketingExecutionSection = dynamic(() => import('./md-strategy/MarketingExecutionSection'), { ssr: false });
const FinancialProjectionSection = dynamic(() => import('./md-strategy/FinancialProjectionSection'), { ssr: false });
const RiskContingencySection = dynamic(() => import('./md-strategy/RiskContingencySection'), { ssr: false });
const StrategyPdfDownload = dynamic(() => import('./md-strategy/StrategyPdfDownload'), { ssr: false });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SavedStrategyData {
	id: string;
	created_at: string;
	goal_analysis?: ParsedGoal | null;
	product_selection?: ProductSelectionOutput;
	channel_strategy?: ChannelStrategyOutput;
	pricing_margin?: PricingMarginOutput;
	marketing_execution?: MarketingExecutionOutput;
	financial_projection?: FinancialProjectionOutput;
	risk_contingency?: RiskContingencyOutput;
}

interface MDStrategyPanelProps {
	mode: 'list' | 'detail';
	initialData?: SavedStrategyData;
}

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
		<Card className="border-blue-600/30 bg-blue-600/5">
			<CardHeader className="pb-2">
				<CardTitle className="text-sm font-semibold flex items-center gap-1.5 text-blue-700 dark:text-blue-300">
					<Database size={14} /> 分析データプレビュー
				</CardTitle>
				<p className="text-[10px] text-muted-foreground">このデータを基にAIが拡大戦略を分析します</p>
			</CardHeader>
			<CardContent className="space-y-4">
				<div className="grid grid-cols-4 gap-2">
					{[
						{ label: '総売上', value: formatYen(overview.totalRevenue) },
						{ label: '粗利率', value: `${overview.marginRate}%` },
						{ label: '商品数', value: `${overview.uniqueProducts}` },
						{ label: '集計週数', value: `${overview.weekCount}週` },
					].map((kpi) => (
						<div key={kpi.label} className="bg-card rounded-lg p-2 text-center border border-blue-600/20">
							<div className="text-[9px] text-muted-foreground">{kpi.label}</div>
							<div className="text-sm font-bold text-foreground">{kpi.value}</div>
						</div>
					))}
				</div>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div>
						<span className="text-[10px] font-semibold text-muted-foreground uppercase">売上TOP5</span>
						<div className="mt-1 space-y-1">
							{topProducts.map((p, i) => (
								<div key={p.code} className="flex items-center gap-2 text-xs bg-card rounded px-2 py-1 border border-border">
									<span className="text-muted-foreground font-mono w-4">{i + 1}</span>
									<span className="text-foreground truncate flex-1">{p.name}</span>
									<span className="font-mono text-foreground shrink-0">{formatYen(p.totalRevenue)}</span>
									<span className="font-mono text-muted-foreground shrink-0 w-12 text-right">{p.marginRate}%</span>
								</div>
							))}
						</div>
					</div>
					<div>
						<span className="text-[10px] font-semibold text-muted-foreground uppercase">カテゴリ別売上 (万円)</span>
						<div className="h-36 mt-1">
							<ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 1, height: 1 }}>
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

function SkillResultsView({ results, generatedAt, backHref, strategyId, onRediscover, rediscovering, discoveredProducts, onAnalyze, analyzingUrl }: {
	results: SkillResults;
	generatedAt?: string | null;
	backHref: string;
	strategyId?: string | null;
	onRediscover?: (focus: string) => Promise<void>;
	rediscovering?: boolean;
	discoveredProducts?: import('@/lib/md-strategy').DiscoveredProduct[];
	onAnalyze?: (sourceUrl: string) => Promise<void>;
	analyzingUrl?: string | null;
}) {
	const hasAny = Object.keys(results).length > 0;
	if (!hasAny) return null;
	const evidence = results.product_selection
		? summarizeMdStrategyEvidence({
				id: strategyId ?? 'current',
				user_goal: null,
				product_selection: {
					...results.product_selection,
					discovered_new_products:
						discoveredProducts ?? results.product_selection.discovered_new_products,
				},
			})
		: null;
	const sourceLabels: Record<string, string> = {
		discovery_pool: '発掘プール',
		fresh_search: '新検索',
		research: 'リサーチ',
		seed: 'シード',
		rakuten: '楽天',
		web: 'Web',
		tv_channel: 'TV局',
	};

	return (
		<>
			{/* Back link */}
			<Link
				href={backHref}
				className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-2 w-fit"
			>
				<ArrowLeft size={14} />
				一覧に戻る
			</Link>

			{/* Read-only search intent chip */}
			{results?.goal_analysis &&
				(results.goal_analysis.intent_tier !== "broad" ||
					(results.goal_analysis.channel_scope?.length ?? 0) > 0) && (
				<div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
					<span className="font-medium text-foreground">検索意図:</span>
					{results.goal_analysis.intent_tier !== "broad" && (
						<span className="rounded bg-blue-500/10 px-2 py-0.5 text-blue-700">
							tier: {results.goal_analysis.intent_tier}
						</span>
					)}
					{results.goal_analysis.channel_scope?.map((c) => (
						<span key={c.channel_slug} className="rounded bg-purple-500/10 px-2 py-0.5 text-purple-700">
							ch: {c.raw_mention}{c.confidence < 0.8 && " (弱)"}
						</span>
					))}
					{results.goal_analysis.specific_keyword && (
						<span className="rounded bg-green-500/10 px-2 py-0.5 text-green-700">
							keyword: {results.goal_analysis.specific_keyword.normalized}
							{results.goal_analysis.specific_keyword.aliases.length > 0 && ` (+${results.goal_analysis.specific_keyword.aliases.length})`}
						</span>
					)}
				</div>
			)}

			<div id="md-strategy-content" className="space-y-8">
				{evidence && (
					<div className="rounded-xl border border-blue-600/25 bg-blue-600/5 px-4 py-3">
						<div className="flex flex-wrap items-center gap-2">
							<span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-600/15 text-blue-700 dark:text-blue-300 font-bold">
								内部実績 {evidence.internalProductCount}件
							</span>
							<span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-600/15 text-amber-800 dark:text-amber-200 font-bold">
								外部候補 {evidence.externalCandidateCount}件
							</span>
							{evidence.poolSourceCounts.map(({ source, count }) => (
								<span
									key={source}
									className="text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border font-semibold"
								>
									{sourceLabels[source] ?? source} {count}件
								</span>
							))}
							{evidence.tvSignalCount > 0 && (
								<span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-600/15 text-purple-700 dark:text-purple-300 border border-purple-600/30 font-semibold">
									TV/OAシグナル {evidence.tvSignalCount}件
								</span>
							)}
							{evidence.discoveredProductIds.length > 0 && (
								<span className="text-[10px] px-2 py-0.5 rounded-full bg-green-600/15 text-green-700 dark:text-green-300 border border-green-600/30 font-semibold">
									Discovery連携 {evidence.discoveredProductIds.length}件
								</span>
							)}
						</div>
						<p className="text-xs text-muted-foreground mt-2">
							既存の販売実績から投入チャネルと主力商品を選び、競合ホームショッピング・発掘プール・リサーチ・新規検索由来の候補を組み合わせて販売戦略を構成しています。
						</p>
					</div>
				)}
				{(discoveredProducts ?? results.product_selection?.discovered_new_products)?.length ? (
					<DiscoveredProductsHero
						products={discoveredProducts ?? results.product_selection!.discovered_new_products!}
						contextLabel="ホームショッピング / EC"
						history={results.product_selection?.discovery_history}
						onRediscover={strategyId ? onRediscover : undefined}
						rediscovering={rediscovering}
						onAnalyze={onAnalyze}
						analyzingUrl={analyzingUrl}
					/>
				) : null}
				{results.product_selection && <ProductSelectionSection data={results.product_selection} />}
				{results.channel_strategy && <ChannelStrategySection data={results.channel_strategy} />}
				{results.pricing_margin && <PricingMarginSection data={results.pricing_margin} />}
				{results.marketing_execution && <MarketingExecutionSection data={results.marketing_execution} />}
				{results.financial_projection && <FinancialProjectionSection data={results.financial_projection} />}
				{results.risk_contingency && <RiskContingencySection data={results.risk_contingency} />}
			</div>

			{generatedAt && (
				<div className="flex items-center justify-between">
					<p className="text-[10px] text-muted-foreground">
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
const MARKETS = ['指定なし', '日本全国', '40-60代女性', '60代以上女性', '20-30代女性', '男女共用'];

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

export default function MDStrategyPanel({ mode, initialData }: MDStrategyPanelProps) {
	const router = useRouter();
	const { locale } = useParams<{ locale: string }>();
	const listHref = localePath(locale, '/analytics/strategy/expansion');

	if (mode === 'detail' && initialData) {
		return <DetailView initialData={initialData} backHref={listHref} />;
	}

	return <ListView locale={locale} router={router} />;
}

// ---------------------------------------------------------------------------
// DetailView — saved strategy from initialData (SSR)
// ---------------------------------------------------------------------------

function DetailView({ initialData, backHref }: { initialData: SavedStrategyData; backHref: string }) {
	const [analyses, setAnalyses] = useState<Record<string, NonNullable<import('@/lib/md-strategy').DiscoveredProduct["sales_strategy"]>>>({});
	const [analyzingUrl, setAnalyzingUrl] = useState<string | null>(null);
	const [savedResults, setSavedResults] = useState<SkillResults>({
		goal_analysis: initialData.goal_analysis ?? undefined,
		product_selection: initialData.product_selection,
		channel_strategy: initialData.channel_strategy,
		pricing_margin: initialData.pricing_margin,
		marketing_execution: initialData.marketing_execution,
		financial_projection: initialData.financial_projection,
		risk_contingency: initialData.risk_contingency,
	});
	const [error, setError] = useState<string | null>(null);
	const [rediscovering, setRediscovering] = useState(false);

	const handleRediscover = useCallback(async (focus: string) => {
		setRediscovering(true);
		setError(null);
		try {
			const res = await fetch(`/api/analytics/md-strategy/${initialData.id}/rediscover`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ focus: focus || undefined }),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

			setSavedResults((prev) => {
				const ps = prev.product_selection;
				if (!ps) return prev;
				return {
					...prev,
					product_selection: {
						...ps,
						discovered_new_products: data.batch.products,
						discovery_history: data.discovery_history,
					},
				};
			});
			setAnalyses({});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRediscovering(false);
		}
	}, [initialData.id]);

	const handleAnalyze = useCallback(async (sourceUrl: string) => {
		setAnalyzingUrl(sourceUrl);
		setError(null);
		try {
			const products = savedResults.product_selection?.discovered_new_products ?? [];
			const product = products.find((p) => p.source_url === sourceUrl);
			const res = await fetch('/api/analytics/discovery/analyze', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sourceUrl,
					product,
					context: 'home_shopping',
					productName: product?.name,
				}),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
			setAnalyses((prev) => ({ ...prev, [sourceUrl]: data.sales_strategy }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setAnalyzingUrl(null);
		}
	}, [savedResults.product_selection]);

	// Merge analyses into discovered products
	const mergedDiscoveredProducts = (() => {
		const raw = savedResults.product_selection?.discovered_new_products;
		if (!raw) return undefined;
		return raw.map((p) =>
			p.source_url && analyses[p.source_url]
				? { ...p, sales_strategy: analyses[p.source_url] }
				: p
		);
	})();

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2">
				<Target size={18} className="text-blue-600" />
				<h3 className="text-lg font-semibold text-foreground">チャネル拡大戦略</h3>
				<span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-600/15 text-blue-700 dark:text-blue-300 font-medium">7-Skill AI</span>
			</div>

			{error && (
				<div className="flex items-center gap-2 p-3 bg-red-600/10 border border-red-600/30 rounded-lg text-sm text-red-700 dark:text-red-300">
					<AlertTriangle size={14} />
					{error}
				</div>
			)}

			<SkillResultsView
				results={savedResults}
				generatedAt={initialData.created_at}
				backHref={backHref}
				strategyId={initialData.id}
				onRediscover={handleRediscover}
				rediscovering={rediscovering}
				discoveredProducts={mergedDiscoveredProducts}
				onAnalyze={handleAnalyze}
				analyzingUrl={analyzingUrl}
			/>
		</div>
	);
}

// ---------------------------------------------------------------------------
// ListView — form + history + in-place generation
// ---------------------------------------------------------------------------

function ListView({ locale, router }: { locale: string; router: ReturnType<typeof useRouter> }) {
	const searchParams = useSearchParams();
	const seedName = searchParams?.get("seed") ?? null;
	const seedCategory = searchParams?.get("category") ?? null;
	const seedPrice = searchParams?.get("price") ?? null;
	const seedUrl = searchParams?.get("sourceUrl") ?? null;
	const seedProductId = searchParams?.get("seedId") ?? null;
	const seedProductIdsRaw = searchParams?.get("seedIds") ?? null;
	const seedProductIds = seedProductIdsRaw
		? seedProductIdsRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
		: null;

	// Input state
	const [userGoal, setUserGoal] = useState(() => {
		if (seedProductIds && seedProductIds.length > 1) {
			return `選択した${seedProductIds.length}件の発掘候補をポートフォリオで戦略立案`;
		}
		if (seedName) {
			return `新商品「${seedName}」の拡大戦略を立てる。${seedUrl ? ` 参考URL: ${seedUrl}` : ""}`;
		}
		return "";
	});
	const [category, setCategory] = useState(seedCategory ?? '指定なし');
	const [targetMarket, setTargetMarket] = useState('指定なし');
	const [priceRange, setPriceRange] = useState(seedPrice ? `¥${Number(seedPrice).toLocaleString()}前後` : '');

	// Generation state
	const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
	const [dataFetchStatus, setDataFetchStatus] = useState<'pending' | 'running' | 'complete'>('pending');
	const [skillStatuses, setSkillStatuses] = useState<Record<SkillName, SkillStatus>>({ ...INITIAL_STATUSES });
	const [skillResults, setSkillResults] = useState<SkillResults>({});
	const [preliminaryProducts, setPreliminaryProducts] = useState<DiscoveredProduct[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const heroRef = useRef<HTMLDivElement | null>(null);
	const hasScrolledRef = useRef(false);

	// History refresh trigger
	const [historyRefresh, setHistoryRefresh] = useState(0);

	const isRunning = status === 'running';

	// R2: block hard navigation (refresh/close) while generating
	useEffect(() => {
		if (!isRunning) return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			e.returnValue = '';
		};
		window.addEventListener('beforeunload', handler);
		return () => window.removeEventListener('beforeunload', handler);
	}, [isRunning]);

	const handleWorkflowEvent = useCallback((event: Record<string, unknown>) => {
		const skill = event.skill as string;
		const eventStatus = event.status as 'running' | 'complete' | 'error';

		// Final completion sentinel
		if (skill === 'data_fetch' && event.index === 999 && eventStatus === 'complete') {
			const data = event.data as { complete?: boolean; strategyId?: string; generatedAt?: string } | undefined;
			setStatus('complete');
			setHistoryRefresh((n) => n + 1);
			// R2: navigate to detail URL on successful generation
			if (data?.strategyId) {
				router.push(localePath(locale, `/analytics/strategy/expansion/${data.strategyId}`));
			}
			return;
		}

		if (skill === 'data_fetch') {
			setDataFetchStatus(eventStatus === 'complete' ? 'complete' : 'running');
			return;
		}

		if (skill === 'preliminary_discovery') {
			if (eventStatus === 'complete') {
				const data = event.data as { products?: DiscoveredProduct[] } | undefined;
				const products = data?.products ?? [];
				if (products.length > 0) setPreliminaryProducts(products);
			}
			return;
		}

		if (eventStatus === 'running') {
			setSkillStatuses((prev) => ({ ...prev, [skill]: 'running' }));
		} else if (eventStatus === 'complete') {
			setSkillStatuses((prev) => ({ ...prev, [skill]: 'complete' }));
			setSkillResults((prev) => ({ ...prev, [skill as SkillName]: event.data }));
		} else if (eventStatus === 'error') {
			setSkillStatuses((prev) => ({ ...prev, [skill]: 'error' }));
			if (event.error) setError(String(event.error));
		}
	}, [locale, router]);

	const handleGenerate = useCallback(async () => {
		setStatus('running');
		setError(null);
		setSkillResults({});
		setSkillStatuses({ ...INITIAL_STATUSES });
		setDataFetchStatus('pending');
		setPreliminaryProducts(null);
		hasScrolledRef.current = false;

		try {
			const startRes = await fetch('/api/analytics/md-strategy', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					userGoal: userGoal || undefined,
					category: category !== '指定なし' ? category : undefined,
					targetMarket: targetMarket !== '指定なし' ? targetMarket : undefined,
					priceRange: priceRange || undefined,
					seedProductId: seedProductId ?? undefined,
					seedProductIds: seedProductIds ?? undefined,
				}),
			});

			if (!startRes.ok) {
				const body = await startRes.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${startRes.status}`);
			}
			const { runId, error: startErr } = await startRes.json();
			if (!runId) throw new Error(startErr || 'Failed to start workflow');

			const streamRes = await fetch(`/api/analytics/md-strategy/run/${runId}/stream`);
			if (!streamRes.ok || !streamRes.body) throw new Error('No stream body');

			const reader = streamRes.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let sawSentinel = false;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;
					try {
						const event = JSON.parse(trimmed);
						if (event?.skill === 'data_fetch' && event?.index === 999 && event?.status === 'complete') {
							sawSentinel = true;
						}
						handleWorkflowEvent(event);
					} catch {
						// skip malformed line
					}
				}
			}

			// Fallback: stream closed without completion sentinel — workflow may still be
			// running durably in background. Poll status endpoint until complete.
			if (!sawSentinel) {
				console.log('[md-panel] stream closed without sentinel — falling back to status polling');
				for (let attempt = 0; attempt < 120; attempt++) {
					await new Promise((r) => setTimeout(r, 5000));
					try {
						const sres = await fetch(`/api/analytics/md-strategy/run/${runId}/status`);
						if (!sres.ok) continue;
						const sdata = await sres.json() as { status: string; returnValue?: { strategyId?: string; generatedAt?: string } };
						if (sdata.status === 'completed') {
							handleWorkflowEvent({
								skill: 'data_fetch', index: 999, status: 'complete',
								data: { complete: true, ...sdata.returnValue },
							});
							break;
						}
						if (sdata.status === 'failed' || sdata.status === 'cancelled') {
							setError(`Workflow ${sdata.status}`);
							setStatus('error');
							break;
						}
					} catch { /* keep polling */ }
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatus('error');
		}
	}, [userGoal, category, targetMarket, priceRange, handleWorkflowEvent]);

	const handleViewSaved = (id: string) => {
		router.push(localePath(locale, `/analytics/strategy/expansion/${id}`));
	};

	const hasGeneratedResults = !!(
		skillResults.product_selection ||
		skillResults.channel_strategy ||
		skillResults.pricing_margin ||
		skillResults.marketing_execution ||
		skillResults.financial_projection ||
		skillResults.risk_contingency
	);

	const curatedDiscovered = skillResults.product_selection?.discovered_new_products ?? null;
	const heroProducts = (curatedDiscovered && curatedDiscovered.length > 0)
		? curatedDiscovered
		: preliminaryProducts;
	const showingPreliminary = !curatedDiscovered && !!preliminaryProducts && preliminaryProducts.length > 0;

	// Auto-scroll to hero the first time products appear (preliminary or curated).
	useEffect(() => {
		if (!isRunning) return;
		if (hasScrolledRef.current) return;
		if (!heroProducts || heroProducts.length === 0) return;
		hasScrolledRef.current = true;
		// Defer one frame so the node is mounted.
		requestAnimationFrame(() => {
			heroRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
		});
	}, [isRunning, heroProducts]);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center gap-2">
				<Target size={18} className="text-blue-600" />
				<h3 className="text-lg font-semibold text-foreground">チャネル拡大戦略</h3>
				<span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-600/15 text-blue-700 dark:text-blue-300 font-medium">7-Skill AI</span>
			</div>

			{/* Form (always visible in list view) */}
			<Card className="border-border">
				<CardContent className="p-4 space-y-3">
					<div>
						<label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1.5 block">
							拡大の目標・方向性 (任意)
						</label>
						<textarea
							value={userGoal}
							onChange={(e) => setUserGoal(e.target.value)}
							placeholder="例: 楽天・Amazonで月商1000万を目指したい / TikTokで若年層にリーチしたい / 韓国Coupangへの越境ECを検討中"
							rows={3}
							disabled={isRunning}
							className="w-full border border-border bg-background text-foreground rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 resize-none disabled:bg-muted"
						/>
					</div>

					<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
						<div>
							<label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">カテゴリ</label>
							<select value={category} onChange={(e) => setCategory(e.target.value)} disabled={isRunning} className="w-full border border-border bg-background text-foreground rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:bg-muted">
								{CATEGORIES.map((c) => <option key={c}>{c}</option>)}
							</select>
						</div>
						<div>
							<label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">ターゲット市場</label>
							<select value={targetMarket} onChange={(e) => setTargetMarket(e.target.value)} disabled={isRunning} className="w-full border border-border bg-background text-foreground rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:bg-muted">
								{MARKETS.map((m) => <option key={m}>{m}</option>)}
							</select>
						</div>
						<div>
							<label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 block">価格帯（任意）</label>
							<input type="text" value={priceRange} onChange={(e) => setPriceRange(e.target.value)} disabled={isRunning} placeholder="例: ¥3,000-8,000" className="w-full border border-border bg-background text-foreground rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:bg-muted" />
						</div>
					</div>
					<p className="text-[10px] text-muted-foreground">
						カテゴリとターゲット市場を指定すると、AI推薦商品も戦略に組み込まれます（指定なしでも分析可能）
					</p>

					<div className="flex items-center justify-between pt-1">
						<p className="text-[10px] text-muted-foreground">
							7つの専門スキル（目標分析→商品選定→チャネル戦略→価格設計→マーケ計画→収益予測→リスク対策）が順次分析します
						</p>
						<button
							type="button"
							onClick={handleGenerate}
							disabled={isRunning}
							className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{isRunning ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
							{isRunning ? '分析中...' : '拡大戦略を分析'}
						</button>
					</div>
				</CardContent>
			</Card>

			{/* Generation error */}
			{error && (
				<div className="flex items-center gap-2 p-3 bg-red-600/10 border border-red-600/30 rounded-lg text-sm text-red-700 dark:text-red-300">
					<AlertTriangle size={14} />
					{error}
				</div>
			)}

			{/* Generation in progress */}
			{isRunning && (
				<>
					<div className="flex items-center gap-2 p-3 bg-amber-600/10 border border-amber-600/30 rounded-lg text-xs text-amber-700 dark:text-amber-300">
						<AlertTriangle size={12} />
						分析中はタブを離れたりページを閉じたりしないでください（中断されます）
					</div>
					<StrategyProgress skillStatuses={skillStatuses} dataFetchStatus={dataFetchStatus} />
				</>
			)}

			{/* Hero appears as soon as preliminary discovery returns; replaced by
			    curated set when the final discovery step finishes. */}
			{isRunning && heroProducts && heroProducts.length > 0 && (
				<div ref={heroRef} className="space-y-3">
					{showingPreliminary && (
						<div className="flex items-center gap-2 p-3 bg-amber-600/10 border border-amber-600/30 rounded-lg text-xs text-amber-700 dark:text-amber-300">
							<Sparkles size={12} />
							候補プールから先行表示中・分析完了後に戦略に沿って絞り込みます
						</div>
					)}
					<DiscoveredProductsHero
						products={heroProducts}
						contextLabel="ホームショッピング / EC"
						history={skillResults.product_selection?.discovery_history}
					/>
				</div>
			)}

			{/* In-progress partial results (skill outputs below the hero) */}
			{isRunning && hasGeneratedResults && (
				<div id="md-strategy-content" className="space-y-8">
					{skillResults.product_selection && <ProductSelectionSection data={skillResults.product_selection} />}
					{skillResults.channel_strategy && <ChannelStrategySection data={skillResults.channel_strategy} />}
					{skillResults.pricing_margin && <PricingMarginSection data={skillResults.pricing_margin} />}
					{skillResults.marketing_execution && <MarketingExecutionSection data={skillResults.marketing_execution} />}
					{skillResults.financial_projection && <FinancialProjectionSection data={skillResults.financial_projection} />}
					{skillResults.risk_contingency && <RiskContingencySection data={skillResults.risk_contingency} />}
				</div>
			)}

			{!isRunning && (
				<>
					<DataPreview />
					<StrategyHistory onView={handleViewSaved} refreshKey={historyRefresh} />
				</>
			)}
		</div>
	);
}
