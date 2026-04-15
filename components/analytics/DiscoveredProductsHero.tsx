'use client';

import { useState } from 'react';
import {
	Sparkles, ExternalLink, Target, Megaphone, Palette, Tag, Users, ShoppingCart,
	RefreshCw, ChevronDown, ChevronUp, AlertTriangle, CheckCircle2, Calendar, Lightbulb,
	Loader2, TrendingUp, Star,
} from 'lucide-react';
import type { DiscoveredProduct, DiscoveryBatch } from '@/lib/md-strategy';

interface Props {
	products: DiscoveredProduct[];
	contextLabel: string;
	history?: DiscoveryBatch[];
	onRediscover?: (focus: string) => Promise<void> | void;
	rediscovering?: boolean;
	onAnalyze?: (sourceUrl: string) => Promise<void> | void;
	analyzingUrl?: string | null;
}

function scoreColor(score: number): string {
	if (score >= 80) return 'text-green-700 bg-green-100 border-green-300';
	if (score >= 60) return 'text-blue-700 bg-blue-100 border-blue-300';
	if (score >= 40) return 'text-yellow-700 bg-yellow-100 border-yellow-300';
	return 'text-red-700 bg-red-100 border-red-300';
}

function ProductCard({ p, idx, onAnalyze, analyzing }: {
	p: DiscoveredProduct;
	idx: number;
	onAnalyze?: (sourceUrl: string) => void;
	analyzing?: boolean;
}) {
	const [expanded, setExpanded] = useState(false);
	const s = p.sales_strategy;

	return (
		<article className="bg-white border border-amber-200 rounded-xl p-4 shadow-sm flex flex-col">
			{/* Header */}
			<div className="flex items-start justify-between gap-2 mb-2">
				<div className="flex items-center gap-2 flex-1 min-w-0">
					<span
						className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${
							p.source === 'rakuten' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'
						}`}
					>
						{p.source === 'rakuten' ? '楽天' : 'Web'}
					</span>
					<h3 className="font-bold text-sm text-gray-900 truncate" title={p.name}>
						<span className="text-gray-400 mr-1">#{idx + 1}</span>
						{p.name}
					</h3>
				</div>
				<span className={`text-xs font-bold px-2 py-0.5 rounded-full border shrink-0 ${scoreColor(p.japan_fit_score)}`}>
					{p.japan_fit_score}
				</span>
			</div>

			<div className="flex flex-wrap gap-1.5 text-[10px] text-gray-500 mb-2">
				<span className="bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5">
					需要 <strong className="text-gray-800">{p.estimated_demand}</strong>
				</span>
				<span className="bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5">
					価格 <strong className="text-gray-800">{p.estimated_price_jpy}</strong>
				</span>
				<span className="bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5">
					供給 <strong className="text-gray-800">{p.supply_source}</strong>
				</span>
			</div>

			<p className="text-xs text-gray-700 leading-relaxed mb-2">{p.reason}</p>
			<p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-100 rounded px-2 py-1 mb-2">
				<span className="font-semibold">TVシグナル根拠:</span> {p.signal_basis}
			</p>

			{/* Japan market fit — why this product fits the JP market right now */}
			{p.japan_market_fit && (
				<div className="bg-rose-50 border border-rose-100 rounded px-2 py-2 mb-3 space-y-1">
					<div className="flex items-center gap-1 mb-0.5">
						<TrendingUp size={11} className="text-rose-600" />
						<span className="text-[10px] font-bold text-rose-700 uppercase tracking-wide">日本市場フィット</span>
						{p.japan_market_fit.review_signal &&
						p.japan_market_fit.review_signal !== 'null' &&
						p.japan_market_fit.review_signal !== '不明' && (
							<span className="ml-auto text-[10px] text-rose-700 flex items-center gap-0.5">
								<Star size={9} className="fill-rose-500 text-rose-500" />
								{p.japan_market_fit.review_signal}
							</span>
						)}
					</div>
					{p.japan_market_fit.popularity_evidence && (
						<div className="text-[11px] text-gray-700">
							<span className="font-semibold text-rose-800">人気根拠:</span> {p.japan_market_fit.popularity_evidence}
						</div>
					)}
					{p.japan_market_fit.trend_context && (
						<div className="text-[11px] text-gray-700">
							<span className="font-semibold text-rose-800">市場トレンド:</span> {p.japan_market_fit.trend_context}
						</div>
					)}
					{p.japan_market_fit.why_japan_now && (
						<div className="text-[11px] text-gray-700">
							<span className="font-semibold text-rose-800">なぜ今日本で:</span> {p.japan_market_fit.why_japan_now}
						</div>
					)}
				</div>
			)}

			{/* Analyze button — shown when no sales_strategy yet */}
			{!s && onAnalyze && p.source_url && (
				<div className="border-t border-gray-100 pt-3">
					<button
						type="button"
						onClick={() => onAnalyze(p.source_url)}
						disabled={analyzing}
						className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-800 text-xs font-semibold rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
					>
						{analyzing ? (
							<><Loader2 size={12} className="animate-spin" /> 分析中...</>
						) : (
							<><Sparkles size={12} /> この商品を分析する</>
						)}
					</button>
				</div>
			)}

			{/* Sales strategy summary (always visible) */}
			{s && (
				<div className="border-t border-gray-100 pt-3 space-y-2">
					<div className="flex items-center justify-between mb-1">
						<div className="flex items-center gap-1.5">
							<Target size={12} className="text-blue-600" />
							<span className="text-[10px] font-bold text-blue-700 uppercase tracking-wide">販売戦略</span>
						</div>
						<button
							type="button"
							onClick={() => setExpanded((v) => !v)}
							className="text-[10px] text-blue-600 hover:text-blue-800 flex items-center gap-0.5"
						>
							{expanded ? <>簡略表示 <ChevronUp size={10} /></> : <>詳細を見る <ChevronDown size={10} /></>}
						</button>
					</div>

					{s.unique_value_prop && (
						<div className="text-[11px] text-gray-800 bg-blue-50 border border-blue-100 rounded px-2 py-1.5 leading-relaxed">
							<span className="font-semibold text-blue-700">USP:</span> {s.unique_value_prop}
						</div>
					)}

					{s.positioning && (
						<div className="text-[11px] text-gray-700 leading-relaxed">
							<span className="font-semibold text-gray-900">ポジショニング:</span> {s.positioning}
						</div>
					)}

					{s.target_segment && (
						<div className="text-[11px] text-gray-700 flex items-start gap-1">
							<Users size={11} className="text-gray-400 mt-0.5 shrink-0" />
							<span><span className="font-semibold text-gray-900">ターゲット:</span> {s.target_segment}</span>
						</div>
					)}

					{s.key_selling_points?.length > 0 && (
						<div className="text-[11px] text-gray-700">
							<div className="font-semibold text-gray-900 mb-0.5">訴求ポイント:</div>
							<ul className="space-y-0.5 ml-1">
								{s.key_selling_points.map((pt, i) => (
									<li key={i} className="flex items-start gap-1">
										<span className="text-amber-500 mt-0.5">•</span>
										<span>{pt}</span>
									</li>
								))}
							</ul>
						</div>
					)}

					{s.recommended_channels?.length > 0 && (
						<div>
							<div className="flex items-center gap-1 mb-1">
								<ShoppingCart size={11} className="text-gray-400" />
								<span className="text-[10px] font-semibold text-gray-900">推奨チャネル</span>
							</div>
							<div className="space-y-1 ml-3">
								{s.recommended_channels.map((ch, i) => (
									<div key={i} className="text-[11px] text-gray-700 flex items-start gap-1">
										<span
											className={`text-[9px] px-1.5 py-0.5 rounded font-bold shrink-0 ${
												ch.priority === 'primary'
													? 'bg-blue-600 text-white'
													: 'bg-gray-200 text-gray-600'
											}`}
										>
											{ch.priority === 'primary' ? '主' : '副'}
										</span>
										<span><strong className="text-gray-900">{ch.name}</strong> — {ch.rationale}</span>
									</div>
								))}
							</div>
						</div>
					)}

					{/* Detailed strategy (expandable) */}
					{expanded && (
						<div className="space-y-2 pt-2 mt-2 border-t border-dashed border-gray-200">
							{s.pricing_approach && (
								<div className="text-[11px] text-gray-700 flex items-start gap-1">
									<Tag size={11} className="text-gray-400 mt-0.5 shrink-0" />
									<span><span className="font-semibold text-gray-900">価格戦略:</span> {s.pricing_approach}</span>
								</div>
							)}

							{s.bundle_ideas?.length > 0 && (
								<div className="text-[11px] text-gray-700">
									<div className="font-semibold text-gray-900 mb-0.5">バンドル案:</div>
									<ul className="space-y-0.5 ml-1">
										{s.bundle_ideas.map((b, i) => (
											<li key={i} className="flex items-start gap-1">
												<span className="text-purple-500 mt-0.5">◆</span>
												<span>{b}</span>
											</li>
										))}
									</ul>
								</div>
							)}

							{s.promo_hook && (
								<div className="text-[11px] text-gray-700 flex items-start gap-1">
									<Megaphone size={11} className="text-gray-400 mt-0.5 shrink-0" />
									<span><span className="font-semibold text-gray-900">プロモフック:</span> {s.promo_hook}</span>
								</div>
							)}

							{s.launch_timing && (
								<div className="text-[11px] text-gray-700 flex items-start gap-1">
									<Calendar size={11} className="text-gray-400 mt-0.5 shrink-0" />
									<span><span className="font-semibold text-gray-900">投入時期:</span> {s.launch_timing}</span>
								</div>
							)}

							{s.content_angle && (
								<div className="text-[11px] text-gray-700 flex items-start gap-1">
									<Palette size={11} className="text-gray-400 mt-0.5 shrink-0" />
									<span><span className="font-semibold text-gray-900">コンテンツ角度:</span> {s.content_angle}</span>
								</div>
							)}

							{s.content_pillars?.length > 0 && (
								<div className="text-[11px] text-gray-700 ml-4">
									<span className="font-semibold text-gray-900">コンテンツの柱:</span>
									<div className="flex flex-wrap gap-1 mt-0.5">
										{s.content_pillars.map((cp, i) => (
											<span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200">
												{cp}
											</span>
										))}
									</div>
								</div>
							)}

							{s.competitor_diff && (
								<div className="text-[11px] text-gray-700 flex items-start gap-1">
									<Lightbulb size={11} className="text-gray-400 mt-0.5 shrink-0" />
									<span><span className="font-semibold text-gray-900">競合差別化:</span> {s.competitor_diff}</span>
								</div>
							)}

							{s.first_30_days?.length > 0 && (
								<div className="text-[11px]">
									<div className="font-semibold text-gray-900 mb-0.5 flex items-center gap-1">
										<CheckCircle2 size={11} className="text-green-600" />
										最初の30日アクション:
									</div>
									<ol className="space-y-0.5 ml-1">
										{s.first_30_days.map((act, i) => (
											<li key={i} className="flex items-start gap-1.5 text-gray-700">
												<span className="bg-green-100 text-green-700 rounded-full w-4 h-4 flex items-center justify-center text-[9px] shrink-0 mt-0.5 font-bold">
													{i + 1}
												</span>
												<span>{act}</span>
											</li>
										))}
									</ol>
								</div>
							)}

							{s.risks?.length > 0 && (
								<div className="text-[11px] bg-orange-50 border border-orange-100 rounded px-2 py-1.5">
									<div className="font-semibold text-orange-700 mb-0.5 flex items-center gap-1">
										<AlertTriangle size={11} />
										リスク:
									</div>
									<ul className="space-y-0.5 ml-1">
										{s.risks.map((r, i) => (
											<li key={i} className="text-gray-700">• {r}</li>
										))}
									</ul>
								</div>
							)}
						</div>
					)}
				</div>
			)}

			{p.source_url && (
				<a
					href={p.source_url}
					target="_blank"
					rel="noopener noreferrer"
					className="mt-3 inline-flex items-center gap-1 text-[11px] text-blue-600 hover:text-blue-800 hover:underline self-start"
				>
					出典ページを確認 <ExternalLink size={10} />
				</a>
			)}
		</article>
	);
}

export default function DiscoveredProductsHero({
	products,
	contextLabel,
	history,
	onRediscover,
	rediscovering,
	onAnalyze,
	analyzingUrl,
}: Props) {
	const [focus, setFocus] = useState('');
	const [showHistory, setShowHistory] = useState(false);
	const [activeBatchIndex, setActiveBatchIndex] = useState(0);

	if (!products || products.length === 0) return null;

	// Use products prop for latest batch (may have merged analyses),
	// fall back to history for older batches.
	const displayProducts = history && history.length > 0 && activeBatchIndex > 0
		? history[activeBatchIndex]?.products ?? products
		: products;

	const handleRediscoverClick = async () => {
		if (!onRediscover || rediscovering) return;
		await onRediscover(focus.trim());
		setFocus('');
		setActiveBatchIndex(0); // jump back to latest after re-discovery
	};

	return (
		<section className="rounded-2xl border-2 border-amber-300 bg-gradient-to-br from-amber-50 to-orange-50 p-5 shadow-sm">
			<div className="flex items-center gap-2 mb-1">
				<Sparkles size={20} className="text-amber-600" />
				<h2 className="text-xl font-bold text-amber-900">発掘された新商品</h2>
				<span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-200 text-amber-800 font-bold uppercase">
					{contextLabel}
				</span>
			</div>
			<p className="text-xs text-gray-600 mb-4">
				TV通販の販売シグナルを基に、楽天 / Web 検索で実在する新商品プールから AI が選定。{onAnalyze ? '各商品を個別に分析できます。' : '各商品ごとに詳細な販売戦略付き。'}
			</p>

			{/* Re-discover bar */}
			{onRediscover && (
				<div className="bg-white border border-amber-200 rounded-xl p-3 mb-4 flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
					<input
						type="text"
						value={focus}
						onChange={(e) => setFocus(e.target.value)}
						placeholder="フォーカス絞り込み (任意) — 例: 美容家電に絞って / 韓国コスメ中心 / ¥5000以下"
						className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-amber-300"
						disabled={rediscovering}
					/>
					<button
						type="button"
						onClick={handleRediscoverClick}
						disabled={rediscovering}
						className="flex items-center justify-center gap-1.5 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-lg transition-colors shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
					>
						{rediscovering ? (
							<>
								<Loader2 size={12} className="animate-spin" />
								発掘中...
							</>
						) : (
							<>
								<RefreshCw size={12} />
								新商品を再発掘
							</>
						)}
					</button>
				</div>
			)}

			{/* History batch selector */}
			{history && history.length > 1 && (
				<div className="mb-4">
					<button
						type="button"
						onClick={() => setShowHistory((v) => !v)}
						className="flex items-center gap-1 text-xs text-amber-700 hover:text-amber-900 font-semibold"
					>
						{showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
						発掘履歴 ({history.length}回)
					</button>
					{showHistory && (
						<div className="mt-2 flex flex-wrap gap-1.5">
							{history.map((batch, i) => {
								const date = new Date(batch.generatedAt);
								const isActive = i === activeBatchIndex;
								return (
									<button
										key={`${batch.generatedAt}-${i}`}
										type="button"
										onClick={() => setActiveBatchIndex(i)}
										className={`text-[10px] px-2 py-1 rounded-lg border transition-colors ${
											isActive
												? 'bg-amber-600 text-white border-amber-600'
												: 'bg-white text-gray-700 border-gray-200 hover:border-amber-300'
										}`}
									>
										#{history.length - i} {date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
										{batch.focus && ` · ${batch.focus.slice(0, 12)}`}
										{i === 0 && ' (最新)'}
									</button>
								);
							})}
						</div>
					)}
				</div>
			)}

			<div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
				{displayProducts.map((p, idx) => (
					<ProductCard
					key={`${p.source_url}-${idx}`}
					p={p}
					idx={idx}
					onAnalyze={onAnalyze}
					analyzing={!!rediscovering || (!!analyzingUrl && analyzingUrl === p.source_url)}
				/>
				))}
			</div>
		</section>
	);
}
