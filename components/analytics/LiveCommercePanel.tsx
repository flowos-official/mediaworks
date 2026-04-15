'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, Radio, AlertTriangle, ArrowLeft, ExternalLink, CheckCircle, Circle } from 'lucide-react';
import type {
	LCSkillName,
	ParsedGoal,
	MarketResearchOutput,
	PlatformAnalysisOutput,
	ContentStrategyOutput,
	ExecutionPlanOutput,
	RiskAnalysisOutput,
} from '@/lib/live-commerce-strategy';
import { LC_SKILL_META } from '@/lib/live-commerce-strategy';

import dynamic from 'next/dynamic';
import DiscoveredProductsHero from './DiscoveredProductsHero';
const MarketOverviewSection = dynamic(() => import('./live-commerce/MarketOverviewSection'), { ssr: false });
const PlatformAnalysisSection = dynamic(() => import('./live-commerce/PlatformAnalysisSection'), { ssr: false });
const ContentStrategySection = dynamic(() => import('./live-commerce/ContentStrategySection'), { ssr: false });
const ExecutionPlanSection = dynamic(() => import('./live-commerce/ExecutionPlanSection'), { ssr: false });
const RiskAnalysisSection = dynamic(() => import('./live-commerce/RiskAnalysisSection'), { ssr: false });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SavedLCData {
	id: string;
	created_at: string;
	goal_analysis?: ParsedGoal | null;
	market_research?: MarketResearchOutput;
	platform_analysis?: PlatformAnalysisOutput;
	content_strategy?: ContentStrategyOutput;
	execution_plan?: ExecutionPlanOutput;
	risk_analysis?: RiskAnalysisOutput;
	search_sources?: Array<{ title: string; url: string }>;
}

interface LiveCommercePanelProps {
	mode: 'list' | 'detail';
	initialData?: SavedLCData;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SkillStatus = 'pending' | 'running' | 'complete' | 'error';

interface SkillResults {
	goal_analysis?: ParsedGoal | null;
	market_research?: MarketResearchOutput;
	platform_analysis?: PlatformAnalysisOutput;
	content_strategy?: ContentStrategyOutput;
	execution_plan?: ExecutionPlanOutput;
	risk_analysis?: RiskAnalysisOutput;
}

const INITIAL_STATUSES: Record<LCSkillName, SkillStatus> = {
	goal_analysis: 'pending',
	market_research: 'pending',
	platform_analysis: 'pending',
	content_strategy: 'pending',
	execution_plan: 'pending',
	risk_analysis: 'pending',
};

const LC_SKILL_ORDER: LCSkillName[] = [
	'goal_analysis', 'market_research', 'platform_analysis',
	'content_strategy', 'execution_plan', 'risk_analysis',
];

const PLATFORMS = ['TikTok Live', 'Instagram Live', 'YouTube Live', '楽天ROOM LIVE', 'Yahoo!ショッピング LIVE'];

// ---------------------------------------------------------------------------
// Progress component
// ---------------------------------------------------------------------------

function LCProgress({ skillStatuses, dataFetchStatus }: {
	skillStatuses: Record<LCSkillName, SkillStatus>;
	dataFetchStatus: 'pending' | 'running' | 'complete';
}) {
	return (
		<div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
			<h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">分析進捗</h4>
			<div className="flex items-center gap-3 mb-2 pb-2 border-b border-gray-100">
				<StatusIcon status={dataFetchStatus} />
				<span className={`text-sm ${dataFetchStatus === 'running' ? 'text-blue-700 font-medium' : 'text-gray-600'}`}>
					ウェブリサーチ
				</span>
			</div>
			<div className="space-y-1.5">
				{LC_SKILL_ORDER.map((skill, i) => {
					const status = skillStatuses[skill];
					const meta = LC_SKILL_META[skill];
					return (
						<div key={skill} className="flex items-center gap-3">
							<div className="relative flex items-center justify-center w-5">
								{i > 0 && (
									<div className={`absolute -top-2.5 w-px h-2.5 ${
										skillStatuses[LC_SKILL_ORDER[i - 1]] === 'complete' ? 'bg-green-300' : 'bg-gray-200'
									}`} />
								)}
								<StatusIcon status={status} />
							</div>
							<div className="flex items-center gap-2 flex-1 min-w-0">
								<span className={`text-sm truncate ${
									status === 'running' ? 'text-blue-700 font-medium' :
									status === 'complete' ? 'text-gray-700' :
									status === 'error' ? 'text-red-600' : 'text-gray-400'
								}`}>
									{meta.labelJa}
								</span>
								{status === 'running' && (
									<span className="text-[10px] text-blue-500 animate-pulse">分析中...</span>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function StatusIcon({ status }: { status: string }) {
	switch (status) {
		case 'complete': return <CheckCircle size={16} className="text-green-500 shrink-0" />;
		case 'running': return <Loader2 size={16} className="text-blue-600 animate-spin shrink-0" />;
		case 'error': return <AlertTriangle size={16} className="text-red-500 shrink-0" />;
		default: return <Circle size={16} className="text-gray-300 shrink-0" />;
	}
}

// ---------------------------------------------------------------------------
// Sources component
// ---------------------------------------------------------------------------

function SourcesCited({ sources }: { sources?: Array<{ title: string; url: string }> }) {
	if (!sources || sources.length === 0) return null;
	const unique = sources.filter((s, i, arr) => arr.findIndex((x) => x.url === s.url) === i).slice(0, 20);
	return (
		<div className="border-t border-gray-100 pt-3 mt-4">
			<span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">出典</span>
			<div className="mt-1 space-y-0.5">
				{unique.map((s, i) => (
					<a key={i} href={s.url} target="_blank" rel="noopener noreferrer"
						className="flex items-center gap-1.5 text-[10px] text-blue-500 hover:text-blue-700 hover:underline truncate">
						<span className="text-gray-400 font-mono shrink-0">[{i + 1}]</span>
						<ExternalLink size={9} className="shrink-0" />
						<span className="truncate">{s.title || s.url}</span>
					</a>
				))}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// History component
// ---------------------------------------------------------------------------

type StrategySummary = {
	id: string;
	user_goal: string | null;
	target_platforms: string[] | null;
	created_at: string;
};

function LCHistory({ onView, refreshKey }: { onView: (id: string) => void; refreshKey: number }) {
	const [strategies, setStrategies] = useState<StrategySummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [deleting, setDeleting] = useState<string | null>(null);

	const fetchList = useCallback(async () => {
		setLoading(true);
		try {
			const res = await fetch('/api/analytics/live-commerce');
			const data = await res.json();
			setStrategies(data.strategies ?? []);
		} catch { /* silent */ } finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchList();
	}, [fetchList, refreshKey]);

	const handleDelete = async (id: string) => {
		if (!confirm('この戦略を削除しますか？')) return;
		setDeleting(id);
		try {
			const res = await fetch(`/api/analytics/live-commerce/${id}`, { method: 'DELETE' });
			if (res.ok) setStrategies((prev) => prev.filter((s) => s.id !== id));
		} catch { /* silent */ } finally {
			setDeleting(null);
		}
	};

	if (loading) {
		return <div className="flex items-center gap-2 py-4 text-sm text-gray-400"><Loader2 size={14} className="animate-spin" />履歴を読み込み中...</div>;
	}
	if (strategies.length === 0) return null;

	return (
		<Card className="border-gray-200">
			<CardContent className="p-4">
				<span className="text-sm font-semibold text-gray-700 flex items-center gap-1.5 mb-3">
					過去のライブコマース戦略
				</span>
				<div className="space-y-2">
					{strategies.map((s) => (
						<div key={s.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-100 hover:border-gray-200 transition-colors">
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2 mb-0.5">
									<span className="text-xs font-mono text-gray-500">
										{new Date(s.created_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
									</span>
									{(s.target_platforms ?? []).slice(0, 2).map((p) => (
										<span key={p} className="text-[9px] px-1.5 py-0.5 bg-pink-50 text-pink-700 rounded">{p}</span>
									))}
								</div>
								<p className="text-xs text-gray-600 truncate">{s.user_goal || '目標指定なし'}</p>
							</div>
							<div className="flex items-center gap-1.5 shrink-0">
								<button type="button" onClick={() => onView(s.id)}
									className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors">
									表示
								</button>
								<button type="button" onClick={() => handleDelete(s.id)} disabled={deleting === s.id}
									className="flex items-center gap-1 px-2 py-1.5 text-xs text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50">
									{deleting === s.id ? <Loader2 size={12} className="animate-spin" /> : '削除'}
								</button>
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}

// ---------------------------------------------------------------------------
// Results view
// ---------------------------------------------------------------------------

function ResultsView({ results, sources, generatedAt, backHref, strategyId, onRediscover, rediscovering, discoveredProducts, onAnalyze, analyzingUrl }: {
	results: SkillResults;
	sources?: Array<{ title: string; url: string }>;
	generatedAt?: string | null;
	backHref: string;
	strategyId?: string | null;
	onRediscover?: (focus: string) => Promise<void>;
	rediscovering?: boolean;
	discoveredProducts?: import('@/lib/md-strategy').DiscoveredProduct[];
	onAnalyze?: (sourceUrl: string) => Promise<void>;
	analyzingUrl?: string | null;
}) {
	return (
		<>
			<Link
				href={backHref}
				className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors mb-2 w-fit"
			>
				<ArrowLeft size={14} />一覧に戻る
			</Link>
			<div id="lc-strategy-content" className="space-y-8">
				{(discoveredProducts ?? results.platform_analysis?.discovered_new_products)?.length ? (
					<DiscoveredProductsHero
						products={discoveredProducts ?? results.platform_analysis!.discovered_new_products!}
						contextLabel="ライブコマース"
						history={results.platform_analysis?.discovery_history}
						onRediscover={strategyId ? onRediscover : undefined}
						rediscovering={rediscovering}
						onAnalyze={onAnalyze}
						analyzingUrl={analyzingUrl}
					/>
				) : null}
				{results.market_research && <MarketOverviewSection data={results.market_research} />}
				{results.platform_analysis && <PlatformAnalysisSection data={results.platform_analysis} />}
				{results.content_strategy && <ContentStrategySection data={results.content_strategy} />}
				{results.execution_plan && <ExecutionPlanSection data={results.execution_plan} />}
				{results.risk_analysis && <RiskAnalysisSection data={results.risk_analysis} />}
				<SourcesCited sources={sources} />
			</div>
			{generatedAt && (
				<p className="text-[10px] text-gray-400 mt-4">生成: {new Date(generatedAt).toLocaleString('ja-JP')}</p>
			)}
		</>
	);
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function LiveCommercePanel({ mode, initialData }: LiveCommercePanelProps) {
	const router = useRouter();
	const { locale } = useParams<{ locale: string }>();
	const listHref = `/${locale}/analytics/live-commerce`;

	if (mode === 'detail' && initialData) {
		return <LCDetailView initialData={initialData} backHref={listHref} />;
	}

	return <LCListView locale={locale} router={router} />;
}

// ---------------------------------------------------------------------------
// DetailView
// ---------------------------------------------------------------------------

function LCDetailView({ initialData, backHref }: { initialData: SavedLCData; backHref: string }) {
	const [analyses, setAnalyses] = useState<Record<string, NonNullable<import('@/lib/md-strategy').DiscoveredProduct["sales_strategy"]>>>({});
	const [analyzingUrl, setAnalyzingUrl] = useState<string | null>(null);
	const [savedResults, setSavedResults] = useState<SkillResults>({
		goal_analysis: initialData.goal_analysis ?? undefined,
		market_research: initialData.market_research,
		platform_analysis: initialData.platform_analysis,
		content_strategy: initialData.content_strategy,
		execution_plan: initialData.execution_plan,
		risk_analysis: initialData.risk_analysis,
	});
	const [error, setError] = useState<string | null>(null);
	const [rediscovering, setRediscovering] = useState(false);

	const handleRediscover = useCallback(async (focus: string) => {
		setRediscovering(true);
		setError(null);
		try {
			const res = await fetch(`/api/analytics/live-commerce/${initialData.id}/rediscover`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ focus: focus || undefined }),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

			setSavedResults((prev) => {
				const pa = prev.platform_analysis;
				if (!pa) return prev;
				return {
					...prev,
					platform_analysis: {
						...pa,
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
			const products = savedResults.platform_analysis?.discovered_new_products ?? [];
			const product = products.find((p) => p.source_url === sourceUrl);
			const res = await fetch('/api/analytics/discovery/analyze', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					sourceUrl,
					product,
					context: 'live_commerce',
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
	}, [savedResults.platform_analysis]);

	const mergedDiscoveredProducts = (() => {
		const raw = savedResults.platform_analysis?.discovered_new_products;
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
				<Radio size={18} className="text-pink-600" />
				<h3 className="text-lg font-semibold text-gray-900">ライブコマース戦略</h3>
				<span className="text-[10px] px-2 py-0.5 rounded-full bg-pink-100 text-pink-700 font-medium">6-Skill AI</span>
			</div>

			{error && (
				<div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
					<AlertTriangle size={14} />{error}
				</div>
			)}

			<ResultsView
				results={savedResults}
				sources={initialData.search_sources}
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
// ListView
// ---------------------------------------------------------------------------

function LCListView({ locale, router }: { locale: string; router: ReturnType<typeof useRouter> }) {
	const [userGoal, setUserGoal] = useState('');
	const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);

	const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
	const [dataFetchStatus, setDataFetchStatus] = useState<'pending' | 'running' | 'complete'>('pending');
	const [skillStatuses, setSkillStatuses] = useState<Record<LCSkillName, SkillStatus>>({ ...INITIAL_STATUSES });
	const [skillResults, setSkillResults] = useState<SkillResults>({});
	const [searchSources, setSearchSources] = useState<Array<{ title: string; url: string }>>([]);
	const [error, setError] = useState<string | null>(null);
	const [historyRefresh, setHistoryRefresh] = useState(0);

	const isRunning = status === 'running';

	// R2: block hard navigation while generating
	useEffect(() => {
		if (!isRunning) return;
		const handler = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			e.returnValue = '';
		};
		window.addEventListener('beforeunload', handler);
		return () => window.removeEventListener('beforeunload', handler);
	}, [isRunning]);

	const togglePlatform = (p: string) => {
		setSelectedPlatforms((prev) =>
			prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
		);
	};

	const handleGenerate = useCallback(async () => {
		setStatus('running');
		setError(null);
		setSkillResults({});
		setSkillStatuses({ ...INITIAL_STATUSES });
		setDataFetchStatus('pending');
		setSearchSources([]);

		try {
			const startRes = await fetch('/api/analytics/live-commerce', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					userGoal: userGoal || undefined,
					targetPlatforms: selectedPlatforms.length > 0 ? selectedPlatforms : undefined,
				}),
			});

			if (!startRes.ok) {
				const body = await startRes.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${startRes.status}`);
			}
			const { runId, error: startErr } = await startRes.json();
			if (!runId) throw new Error(startErr || 'Failed to start workflow');

			const streamRes = await fetch(`/api/analytics/live-commerce/run/${runId}/stream`);
			if (!streamRes.ok || !streamRes.body) throw new Error('No stream body');

			const reader = streamRes.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let sawSentinel = false;

			const handleSentinel = (data: { strategyId?: string; generatedAt?: string } | undefined) => {
				sawSentinel = true;
				setStatus('complete');
				setHistoryRefresh((n) => n + 1);
				if (data?.strategyId) {
					router.push(`/${locale}/analytics/live-commerce/${data.strategyId}`);
				}
			};

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
						const event = JSON.parse(trimmed) as Record<string, unknown>;
						const skill = event.skill as string;
						const eventStatus = event.status as 'running' | 'complete' | 'error';

						// final completion sentinel
						if (skill === 'data_fetch' && event.index === 999 && eventStatus === 'complete') {
							handleSentinel(event.data as { strategyId?: string; generatedAt?: string } | undefined);
							continue;
						}

						if (skill === 'data_fetch') {
							setDataFetchStatus(eventStatus === 'complete' ? 'complete' : 'running');
							continue;
						}

						if (eventStatus === 'running') {
							setSkillStatuses((prev) => ({ ...prev, [skill]: 'running' }));
						} else if (eventStatus === 'complete') {
							setSkillStatuses((prev) => ({ ...prev, [skill]: 'complete' }));
							setSkillResults((prev) => ({ ...prev, [skill as LCSkillName]: event.data }));
						} else if (eventStatus === 'error') {
							setSkillStatuses((prev) => ({ ...prev, [skill]: 'error' }));
							if (event.error) setError(String(event.error));
						}
					} catch { /* skip */ }
				}
			}

			// Fallback: stream closed without sentinel — workflow may still be running.
			if (!sawSentinel) {
				console.log('[lc-panel] stream closed without sentinel — falling back to status polling');
				for (let attempt = 0; attempt < 120; attempt++) {
					await new Promise((r) => setTimeout(r, 5000));
					try {
						const sres = await fetch(`/api/analytics/live-commerce/run/${runId}/status`);
						if (!sres.ok) continue;
						const sdata = await sres.json() as { status: string; returnValue?: { strategyId?: string; generatedAt?: string } };
						if (sdata.status === 'completed') {
							handleSentinel(sdata.returnValue);
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
	}, [userGoal, selectedPlatforms, locale, router]);

	const handleViewSaved = (id: string) => {
		router.push(`/${locale}/analytics/live-commerce/${id}`);
	};

	const hasResults = !!(
		skillResults.market_research || skillResults.platform_analysis ||
		skillResults.content_strategy || skillResults.execution_plan || skillResults.risk_analysis
	);

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-2">
				<Radio size={18} className="text-pink-600" />
				<h3 className="text-lg font-semibold text-gray-900">ライブコマース戦略</h3>
				<span className="text-[10px] px-2 py-0.5 rounded-full bg-pink-100 text-pink-700 font-medium">6-Skill AI</span>
			</div>

			<Card className="border-gray-200">
				<CardContent className="p-4 space-y-3">
					<div>
						<label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
							ライブコマースの目標・方向性 (任意)
						</label>
						<textarea
							value={userGoal}
							onChange={(e) => setUserGoal(e.target.value)}
							placeholder="例: TikTok Liveを中心に月商1000万円を目指したい / Instagram Liveで美容商品の販売を始めたい"
							rows={3}
							disabled={isRunning}
							className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-pink-300 resize-none disabled:bg-gray-50"
						/>
					</div>

					<div>
						<label className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5 block">
							対象プラットフォーム (任意・複数選択可)
						</label>
						<div className="flex flex-wrap gap-2">
							{PLATFORMS.map((p) => (
								<button
									key={p}
									type="button"
									onClick={() => togglePlatform(p)}
									disabled={isRunning}
									className={`px-3 py-1.5 text-xs rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
										selectedPlatforms.includes(p)
											? 'bg-pink-50 border-pink-300 text-pink-700 font-medium'
											: 'bg-white border-gray-200 text-gray-500 hover:border-gray-300'
									}`}
								>
									{p}
								</button>
							))}
						</div>
					</div>

					<div className="flex items-center justify-between pt-1">
						<p className="text-[10px] text-gray-400">
							6つの専門スキル（目標分析→市場調査→プラットフォーム分析→コンテンツ戦略→実行計画→リスク分析）が順次分析します
						</p>
						<button
							type="button"
							onClick={handleGenerate}
							disabled={isRunning}
							className="flex items-center gap-2 px-5 py-2 bg-pink-600 hover:bg-pink-700 text-white text-sm font-semibold rounded-lg transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{isRunning ? <Loader2 size={14} className="animate-spin" /> : <Radio size={14} />}
							{isRunning ? '分析中...' : 'ライブコマース戦略を分析'}
						</button>
					</div>
				</CardContent>
			</Card>

			{error && (
				<div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
					<AlertTriangle size={14} />{error}
				</div>
			)}

			{isRunning && (
				<>
					<div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
						<AlertTriangle size={12} />
						分析中はタブを離れたりページを閉じたりしないでください（中断されます）
					</div>
					<LCProgress skillStatuses={skillStatuses} dataFetchStatus={dataFetchStatus} />
				</>
			)}

			{isRunning && hasResults && (
				<div id="lc-strategy-content" className="space-y-8">
					{(skillResults.platform_analysis?.discovered_new_products?.length ?? 0) > 0 && (
						<DiscoveredProductsHero
							products={skillResults.platform_analysis!.discovered_new_products!}
							contextLabel="ライブコマース"
							history={skillResults.platform_analysis?.discovery_history}
						/>
					)}
					{skillResults.market_research && <MarketOverviewSection data={skillResults.market_research} />}
					{skillResults.platform_analysis && <PlatformAnalysisSection data={skillResults.platform_analysis} />}
					{skillResults.content_strategy && <ContentStrategySection data={skillResults.content_strategy} />}
					{skillResults.execution_plan && <ExecutionPlanSection data={skillResults.execution_plan} />}
					{skillResults.risk_analysis && <RiskAnalysisSection data={skillResults.risk_analysis} />}
					<SourcesCited sources={searchSources} />
				</div>
			)}

			{!isRunning && <LCHistory onView={handleViewSaved} refreshKey={historyRefresh} />}
		</div>
	);
}
