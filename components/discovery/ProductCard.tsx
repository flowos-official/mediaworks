"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Sparkles, Star, TrendingUp, ShoppingBag, Tv, Compass, ChevronDown } from "lucide-react";
import { EnrichmentProgress } from "./EnrichmentProgress";
import { CPackageDrawer } from "./CPackageDrawer";
import { IntegrationActions } from "./IntegrationActions";
import { FeedbackButtons, type FeedbackState } from "./FeedbackButtons";
import type { CPackage, CurationScore } from "@/lib/discovery/types";
import { getChannelBySlug, parseChannelSlugs } from "@/lib/discovery/tv-channels";
import TvEvidenceBadge from "@/components/discovery/TvEvidenceBadge";

type EnrichmentStatus = "idle" | "queued" | "running" | "completed" | "failed";

export type DiscoveredProductRow = {
	id: string;
	name: string;
	thumbnail_url: string | null;
	product_url: string;
	price_jpy: number | null;
	category: string | null;
	seller_name: string | null;
	review_count: number | null;
	review_avg: number | null;
	tv_fit_score: number | null;
	tv_fit_reason: string | null;
	score_breakdown?: CurationScore | null;
	broadcast_tag: "broadcast_confirmed" | "broadcast_likely" | "unknown" | null;
	track: "tv_proven" | "exploration";
	stock_status: string | null;
	source: "rakuten" | "brave" | "tv_channel" | "other" | null;
	tv_channel_source?: string | null;
	rakuten_cross_match?: {
		itemUrl: string;
		itemName: string;
		reviewCount: number;
		reviewAvg: number;
		priceJpy: number;
		similarityScore: number;
	} | null;
	tv_evidence?: { airing_count: number; recent_30d_count: number } | null;
	enrichment_status?: EnrichmentStatus | null;
	c_package?: CPackage | null;
	enrichment_error?: string | null;
	context?: "home_shopping" | "live_commerce";
	user_action?: FeedbackState;
	action_reason?: string | null;
};

function scoreColor(score: number): string {
	if (score >= 80) return "text-green-700 dark:text-green-300 bg-green-600/15 border-green-300 dark:border-green-800/40";
	if (score >= 60) return "text-blue-700 dark:text-blue-300 bg-blue-600/15 border-blue-300 dark:border-blue-800/40";
	if (score >= 40) return "text-yellow-700 dark:text-yellow-300 bg-yellow-600/15 border-yellow-300 dark:border-yellow-800/40";
	return "text-red-700 dark:text-red-300 bg-red-600/15 border-red-300 dark:border-red-800/40";
}

// max points per signal — mirrors lib/discovery/curate.ts §採点基準 (rebalanced 2026-05-21)
// review_signal trimmed (25→15) and freed weight redistributed to forward-looking signals
// (price_fit/purchase_signal 15→20) so TV-channel candidates without review data can compete fairly.
const SCORE_MAX: Record<keyof Omit<CurationScore, "total">, { max: number; label: string; color: string }> = {
	review_signal:     { max: 15, label: "レビュー",   color: "bg-amber-400" },
	tv_category_match: { max: 30, label: "カテゴリ",   color: "bg-purple-400" },
	trend_signal:      { max: 15, label: "トレンド",   color: "bg-pink-400" },
	price_fit:         { max: 20, label: "価格",       color: "bg-blue-400" },
	purchase_signal:   { max: 20, label: "購買",       color: "bg-emerald-400" },
};

function ScoreBreakdownBars({ breakdown }: { breakdown: CurationScore }) {
	const keys = Object.keys(SCORE_MAX) as (keyof typeof SCORE_MAX)[];
	const totalMax = keys.reduce((s, k) => s + SCORE_MAX[k].max, 0); // 100
	return (
		<div className="mt-2 space-y-1">
			{keys.map((k) => {
				const { max, label, color } = SCORE_MAX[k];
				const v = breakdown[k] ?? 0;
				const widthPct = Math.max(0, Math.min(100, (v / max) * 100));
				const shareOfTotalPct = Math.round((v / totalMax) * 100);
				return (
					<div key={k} className="flex items-center gap-2 text-[10px]">
						<span className="w-14 shrink-0 text-muted-foreground font-medium">{label}</span>
						<div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
							<div
								className={`h-full ${color} transition-all`}
								style={{ width: `${widthPct}%` }}
							/>
						</div>
						<span className="w-12 shrink-0 text-right font-mono text-foreground">
							{v}/{max}
						</span>
						<span className="w-8 shrink-0 text-right text-muted-foreground tabular-nums">
							{shareOfTotalPct}%
						</span>
					</div>
				);
			})}
		</div>
	);
}

export function ProductCard({
	product,
	isSelected,
	onToggleSelect,
}: {
	product: DiscoveredProductRow;
	isSelected?: boolean;
	onToggleSelect?: (id: string) => void;
}) {
	const t = useTranslations("discovery");
	const score = product.tv_fit_score ?? 0;
	const isTV = product.track === "tv_proven";
	const channelSlugs = parseChannelSlugs(product.tv_channel_source ?? null);

	const [status, setStatus] = useState<EnrichmentStatus>(
		product.enrichment_status ?? "idle",
	);
	const [pkg, setPkg] = useState<CPackage | null>(product.c_package ?? null);
	const [err, setErr] = useState<string | null>(product.enrichment_error ?? null);
	const [showDetails, setShowDetails] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const [feedbackState, setFeedbackState] = useState<FeedbackState>(product.user_action ?? null);
	const [feedbackReason, setFeedbackReason] = useState<string | null>(product.action_reason ?? null);
	const [showBreakdown, setShowBreakdown] = useState(false);

	const isRejected = feedbackState === "rejected";
	const isDimmed = feedbackState === "rejected" || feedbackState === "duplicate";

	const stopPolling = useCallback(() => {
		if (pollRef.current) {
			clearInterval(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	const pollOnce = useCallback(async () => {
		const res = await fetch(`/api/discovery/enrich/${product.id}`, {
			cache: "no-store",
		});
		if (!res.ok) return;
		const data = await res.json();
		setStatus(data.status);
		if (data.c_package) setPkg(data.c_package);
		if (data.error) setErr(data.error);
		if (data.status === "completed" || data.status === "failed") {
			stopPolling();
			if (data.status === "completed") setShowDetails(true);
		}
	}, [product.id, stopPolling]);

	const startPolling = useCallback(() => {
		stopPolling();
		pollRef.current = setInterval(pollOnce, 2000);
	}, [pollOnce, stopPolling]);

	useEffect(() => {
		return () => stopPolling();
	}, [stopPolling]);

	const triggerEnrichment = useCallback(async () => {
		setErr(null);
		setStatus("queued");
		startPolling();
		try {
			await fetch(`/api/discovery/enrich/${product.id}`, { method: "POST" });
		} catch (error) {
			console.error("enrich POST failed", error);
		}
	}, [product.id, startPolling]);

	const broadcastBadge =
		product.broadcast_tag === "broadcast_confirmed"
			? { label: t("broadcastConfirmed"), color: "bg-red-600/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900/40", icon: <Tv size={10} /> }
			: product.broadcast_tag === "broadcast_likely"
			? { label: t("broadcastLikely"), color: "bg-orange-600/15 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-900/40", icon: <Tv size={10} /> }
			: null;

	return (
		<article
			className={`relative bg-card border border-amber-200 dark:border-amber-900/40 rounded-xl p-4 shadow-sm flex flex-col hover:shadow-md transition-all ${
				isDimmed ? "opacity-60" : ""
			}`}
			title={isRejected && feedbackReason ? `却下理由: ${feedbackReason}` : undefined}
		>
			{onToggleSelect && (
				<input
					type="checkbox"
					checked={!!isSelected}
					onChange={() => onToggleSelect(product.id)}
					onClick={(e) => e.stopPropagation()}
					aria-label="Select for strategy"
					className="absolute top-2 left-2 z-10 w-4 h-4 accent-indigo-600 cursor-pointer"
				/>
			)}
			{/* Header: source badge + name + score */}
			<div className="flex items-start justify-between gap-2 mb-2">
				<div className="flex items-center gap-2 flex-1 min-w-0">
					<span
						className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${
							product.source === "rakuten"
								? "bg-red-600/15 text-red-700 dark:text-red-300"
								: product.source === "tv_channel"
								? "bg-purple-600/15 text-purple-700 dark:text-purple-300"
								: "bg-blue-600/15 text-blue-700 dark:text-blue-300"
						}`}
					>
						{product.source === "rakuten"
							? "楽天"
							: product.source === "tv_channel"
							? "TV"
							: "Web"}
					</span>
					<h3 className="font-bold text-sm text-foreground line-clamp-2" title={product.name}>
						{product.name}
					</h3>
				</div>
				<span
					className={`text-xs font-bold px-2 py-0.5 rounded-full border shrink-0 ${scoreColor(score)}`}
				>
					{score}
				</span>
			</div>

			{/* Thumbnail + metadata row */}
			<div className="flex gap-3 mb-3">
				<div className="flex-shrink-0 w-20 h-20 bg-muted rounded-lg overflow-hidden border border-border">
					{product.thumbnail_url ? (
						<img
							src={product.thumbnail_url}
							alt={product.name}
							className="w-full h-full object-cover"
						/>
					) : (
						<div className="w-full h-full flex items-center justify-center text-muted-foreground">
							<ShoppingBag size={24} />
						</div>
					)}
				</div>
				<div className="flex-1 flex flex-col justify-between min-w-0">
					<div className="flex flex-wrap gap-1.5 text-[10px]">
						<span className="bg-muted border border-border rounded px-1.5 py-0.5 text-muted-foreground">
							価格{" "}
							<strong className="text-foreground">
								{product.price_jpy ? `¥${product.price_jpy.toLocaleString()}` : "¥?"}
							</strong>
						</span>
						{product.review_avg !== null && (
							<span className="bg-yellow-600/10 border border-yellow-200 dark:border-yellow-900/40 rounded px-1.5 py-0.5 text-yellow-800 dark:text-yellow-200 flex items-center gap-0.5">
								<Star size={9} className="fill-yellow-500 text-yellow-500" />
								<strong>{product.review_avg}</strong>
								<span className="text-yellow-600">({product.review_count ?? 0})</span>
							</span>
						)}
					</div>
					<div className="flex flex-wrap gap-1 items-center">
						<span
							className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold ${
								isTV
									? "bg-purple-600/10 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-900/40"
									: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-900/40"
							}`}
						>
							{isTV ? <Tv size={10} /> : <Compass size={10} />}
							{isTV ? t("trackTvProven") : t("trackExploration")}
						</span>
						{broadcastBadge && (
							<span
								className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border ${broadcastBadge.color}`}
							>
								{broadcastBadge.icon}
								{broadcastBadge.label}
							</span>
						)}
						{channelSlugs.map((slug) => {
							const ch = getChannelBySlug(slug);
							return (
								<span
									key={slug}
									className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full bg-purple-600/10 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-900/40 font-semibold"
									title={ch?.name ?? slug}
								>
									{ch?.name ?? slug}
								</span>
							);
						})}
						{/* Honest popularity signals — surface the actual basis for any */}
						{/* popularity inference on TV-channel candidates that don't publish */}
						{/* their own review/sales data. */}
						{product.tv_evidence && product.tv_evidence.airing_count > 0 && (
							<span
								className="inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 rounded-full bg-rose-600/10 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900/40 font-semibold"
								title={`実測放送 ${product.tv_evidence.airing_count}回 (直近30日 ${product.tv_evidence.recent_30d_count}回)`}
							>
								<Tv size={10} />
								放送実績 {product.tv_evidence.airing_count}回
							</span>
						)}
						{product.rakuten_cross_match && (
							<a
								href={product.rakuten_cross_match.itemUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 rounded-full bg-red-600/10 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-900/40 font-semibold hover:bg-red-600/15"
								title={`楽天で同等品が出品されており、その販売実績を popularity proxy として参照しています: ${product.rakuten_cross_match.itemName}`}
								onClick={(e) => e.stopPropagation()}
							>
								<Star size={9} className="fill-red-500 text-red-500" />
								楽天同等品 ★{product.rakuten_cross_match.reviewAvg.toFixed(1)}({product.rakuten_cross_match.reviewCount})
							</a>
						)}
						{product.source === "tv_channel" && !product.tv_evidence && !product.rakuten_cross_match && (
							<span
								className="inline-flex items-center text-[10px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border italic"
								title="このTV局公式サイトはレビュー/販売数を非公開。放送実績・楽天同等品ともに見つからず、popularity データが限定的。"
							>
								データ限定
							</span>
						)}
					</div>
					{product.seller_name && (
						<div className="text-[10px] text-muted-foreground truncate" title={product.seller_name}>
							{product.seller_name}
						</div>
					)}
				</div>
			</div>

			{/* TV fit reason + score breakdown toggle */}
			{(product.tv_fit_reason || product.score_breakdown) && (
				<div className="bg-amber-600/10 border border-amber-200 dark:border-amber-900/40 rounded px-3 py-2 mb-3">
					<div className="flex items-center justify-between gap-2 mb-0.5">
						<div className="flex items-center gap-1">
							<TrendingUp size={11} className="text-amber-600" />
							<span className="text-[10px] font-bold text-amber-700 dark:text-amber-300 uppercase tracking-wide">
								TV適合性
							</span>
						</div>
						{product.score_breakdown && (
							<button
								type="button"
								onClick={() => setShowBreakdown((v) => !v)}
								className="flex items-center gap-0.5 text-[10px] text-amber-700 dark:text-amber-300 hover:text-amber-900 font-semibold"
								aria-expanded={showBreakdown}
							>
								内訳
								<ChevronDown
									size={11}
									className={`transition-transform ${showBreakdown ? "rotate-180" : ""}`}
								/>
							</button>
						)}
					</div>
					{product.tv_fit_reason && (
						<p className="text-[11px] text-amber-900 dark:text-amber-100 leading-relaxed">
							{product.tv_fit_reason}
						</p>
					)}
					<div className="mt-1.5">
						<TvEvidenceBadge productId={product.id} />
					</div>
					{showBreakdown && product.score_breakdown && (
						<ScoreBreakdownBars breakdown={product.score_breakdown} />
					)}
				</div>
			)}

			{/* External link */}
			<div className="pb-2 border-b border-border mb-3">
				<a
					href={product.product_url}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-medium"
				>
					<Sparkles size={11} />
					{t("goLive")} →
				</a>
			</div>

			{/* Feedback buttons (Phase 4) */}
			<FeedbackButtons
				productId={product.id}
				current={feedbackState}
				onUpdate={(next, reason) => {
					setFeedbackState(next);
					setFeedbackReason(reason ?? null);
				}}
			/>

			{/* Integration action (拡大戦略 / ライブ戦略) */}
			<div className="mb-3">
				<IntegrationActions
					productId={product.id}
					context={product.context ?? "home_shopping"}
					productName={product.name}
					category={product.category}
					productUrl={product.product_url}
					priceJpy={product.price_jpy}
					enrichmentStatus={status}
					hasCPackage={!!pkg}
				/>
			</div>

			{/* Enrichment control */}
			<EnrichmentProgress
				status={status}
				hasPackage={!!pkg}
				showDetails={showDetails}
				onTrigger={triggerEnrichment}
				onToggleDetails={() => setShowDetails((v) => !v)}
				error={err}
			/>

			{/* C Package (when expanded) */}
			{showDetails && pkg && <CPackageDrawer pkg={pkg} />}
		</article>
	);
}
