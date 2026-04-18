"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Sparkles, Star, TrendingUp, ShoppingBag, Tv, Compass } from "lucide-react";
import { EnrichmentProgress } from "./EnrichmentProgress";
import { CPackageDrawer } from "./CPackageDrawer";
import { IntegrationActions } from "./IntegrationActions";
import { FeedbackButtons, type FeedbackState } from "./FeedbackButtons";
import type { CPackage } from "@/lib/discovery/types";

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
	broadcast_tag: "broadcast_confirmed" | "broadcast_likely" | "unknown" | null;
	track: "tv_proven" | "exploration";
	stock_status: string | null;
	source: "rakuten" | "brave" | "other" | null;
	enrichment_status?: EnrichmentStatus | null;
	c_package?: CPackage | null;
	enrichment_error?: string | null;
	context?: "home_shopping" | "live_commerce";
	user_action?: FeedbackState;
	action_reason?: string | null;
};

function scoreColor(score: number): string {
	if (score >= 80) return "text-green-700 bg-green-100 border-green-300";
	if (score >= 60) return "text-blue-700 bg-blue-100 border-blue-300";
	if (score >= 40) return "text-yellow-700 bg-yellow-100 border-yellow-300";
	return "text-red-700 bg-red-100 border-red-300";
}

export function ProductCard({ product }: { product: DiscoveredProductRow }) {
	const t = useTranslations("discovery");
	const score = product.tv_fit_score ?? 0;
	const isTV = product.track === "tv_proven";

	const [status, setStatus] = useState<EnrichmentStatus>(
		product.enrichment_status ?? "idle",
	);
	const [pkg, setPkg] = useState<CPackage | null>(product.c_package ?? null);
	const [err, setErr] = useState<string | null>(product.enrichment_error ?? null);
	const [showDetails, setShowDetails] = useState(false);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	const [feedbackState, setFeedbackState] = useState<FeedbackState>(product.user_action ?? null);
	const [feedbackReason, setFeedbackReason] = useState<string | null>(product.action_reason ?? null);

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
			? { label: t("broadcastConfirmed"), color: "bg-red-100 text-red-700 border-red-200", icon: <Tv size={10} /> }
			: product.broadcast_tag === "broadcast_likely"
			? { label: t("broadcastLikely"), color: "bg-orange-100 text-orange-700 border-orange-200", icon: <Tv size={10} /> }
			: null;

	return (
		<article
			className={`bg-white border border-amber-200 rounded-xl p-4 shadow-sm flex flex-col hover:shadow-md transition-all ${
				isDimmed ? "opacity-60" : ""
			}`}
			title={isRejected && feedbackReason ? `却下理由: ${feedbackReason}` : undefined}
		>
			{/* Header: source badge + name + score */}
			<div className="flex items-start justify-between gap-2 mb-2">
				<div className="flex items-center gap-2 flex-1 min-w-0">
					<span
						className={`text-[10px] px-2 py-0.5 rounded-full font-bold shrink-0 ${
							product.source === "rakuten"
								? "bg-red-100 text-red-700"
								: "bg-blue-100 text-blue-700"
						}`}
					>
						{product.source === "rakuten" ? "楽天" : "Web"}
					</span>
					<h3 className="font-bold text-sm text-gray-900 line-clamp-2" title={product.name}>
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
				<div className="flex-shrink-0 w-20 h-20 bg-gray-100 rounded-lg overflow-hidden border border-gray-200">
					{product.thumbnail_url ? (
						<img
							src={product.thumbnail_url}
							alt={product.name}
							className="w-full h-full object-cover"
						/>
					) : (
						<div className="w-full h-full flex items-center justify-center text-gray-300">
							<ShoppingBag size={24} />
						</div>
					)}
				</div>
				<div className="flex-1 flex flex-col justify-between min-w-0">
					<div className="flex flex-wrap gap-1.5 text-[10px]">
						<span className="bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5 text-gray-600">
							価格{" "}
							<strong className="text-gray-900">
								{product.price_jpy ? `¥${product.price_jpy.toLocaleString()}` : "¥?"}
							</strong>
						</span>
						{product.review_avg !== null && (
							<span className="bg-yellow-50 border border-yellow-200 rounded px-1.5 py-0.5 text-yellow-800 flex items-center gap-0.5">
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
									? "bg-purple-50 text-purple-700 border border-purple-200"
									: "bg-emerald-50 text-emerald-700 border border-emerald-200"
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
					</div>
					{product.seller_name && (
						<div className="text-[10px] text-gray-500 truncate" title={product.seller_name}>
							{product.seller_name}
						</div>
					)}
				</div>
			</div>

			{/* TV fit reason */}
			{product.tv_fit_reason && (
				<div className="bg-amber-50 border border-amber-100 rounded px-3 py-2 mb-3">
					<div className="flex items-center gap-1 mb-0.5">
						<TrendingUp size={11} className="text-amber-600" />
						<span className="text-[10px] font-bold text-amber-700 uppercase tracking-wide">
							TV適合性
						</span>
					</div>
					<p className="text-[11px] text-amber-900 leading-relaxed">
						{product.tv_fit_reason}
					</p>
				</div>
			)}

			{/* External link */}
			<div className="pb-2 border-b border-gray-100 mb-3">
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
					context={product.context ?? "home_shopping"}
					productName={product.name}
					category={product.category}
					productUrl={product.product_url}
					priceJpy={product.price_jpy}
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
