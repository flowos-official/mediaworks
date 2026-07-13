"use client";

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AlertTriangle, RefreshCw, TrendingUp } from "lucide-react";
import { DiscoveryHeader } from "@/components/discovery/DiscoveryHeader";
import { ProductCard, type DiscoveredProductRow } from "@/components/discovery/ProductCard";
import {
	DiscoveryFilters,
	type SortKey,
	type StatusFilter,
} from "@/components/discovery/DiscoveryFilters";
import { ContextSubTabs } from "@/components/discovery/ContextSubTabs";
import { ManualTriggerButton } from "@/components/discovery/ManualTriggerButton";
import {
	CategoryFrequencyStrip,
	type CategoryShare,
} from "@/components/discovery/CategoryFrequencyStrip";
import { localePath } from "@/lib/i18n/locale-path";
import type { Context } from "@/lib/discovery/types";
import { useApiQuery } from "@/lib/client/api-cache";

type Session = {
	id: string;
	run_at: string;
	completed_at: string | null;
	status: "running" | "completed" | "partial" | "failed";
	target_count: number;
	produced_count: number;
	iterations: number;
};

type CategoryStats = {
	lookbackDays: number;
	totalSlots: number;
	categories: CategoryShare[];
};

interface DiscoveryTodayClientProps {
	context: Context;
	canManualTrigger: boolean;
}

const INITIAL_TIER_ROWS = 6;
const INITIAL_FLAT_ROWS = 8;
const LOAD_MORE_PRODUCTS = 6;
const EMPTY_PRODUCTS: DiscoveredProductRow[] = [];

const CONTEXT_LABEL: Record<Context, string> = {
	home_shopping: "ホームショッピング",
	live_commerce: "ライブコマース",
};

export function DiscoveryTodayClient({ context, canManualTrigger }: DiscoveryTodayClientProps) {
	const t = useTranslations("discovery");
	const query = useApiQuery<{
		session: Session | null;
		products: DiscoveredProductRow[];
		categoryStats: CategoryStats | null;
	}>(`/api/discovery/today?context=${context}`);
	const session = query.data?.session ?? null;
	const products = query.data?.products ?? EMPTY_PRODUCTS;
	const categoryStats = query.data?.categoryStats ?? null;
	const loading = query.isLoading;
	const loadError = query.error ? t("loadFailed") : null;
	const [status, setStatus] = useState<StatusFilter>("all");
	const [sort, setSort] = useState<SortKey>("score");
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [limits, setLimits] = useState({ key: "", tier1: INITIAL_TIER_ROWS, tier2: INITIAL_TIER_ROWS, flat: INITIAL_FLAT_ROWS });
	const router = useRouter();
	const { locale } = useParams<{ locale: string }>();
	const isHomeShopping = context === "home_shopping";

	const toggleSelect = (id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const matchedCategories = useMemo(() => {
		const set = new Set<string>();
		for (const p of products) {
			const reason = p.tv_fit_reason ?? "";
			const m = reason.match(/\[他局トレンド:\s*([^\]]+)\]/);
			if (m) set.add(m[1].trim());
		}
		return set;
	}, [products]);

	const filtered = useMemo(() => {
		let list = products;
		if (status === "uncategorized") list = list.filter((p) => !(p as unknown as { user_action?: string }).user_action);
		else if (status !== "all")
			list = list.filter((p) => (p as unknown as { user_action?: string }).user_action === status);

		if (isHomeShopping) {
			const tierOf = (p: DiscoveredProductRow) =>
				(p as unknown as { tv_channel_source?: string | null }).tv_channel_source
					? 0
					: 1;
			const sortFn = (a: DiscoveredProductRow, b: DiscoveredProductRow) => {
				const ta = tierOf(a);
				const tb = tierOf(b);
				if (ta !== tb) return ta - tb;
				if (sort === "price") return (b.price_jpy ?? 0) - (a.price_jpy ?? 0);
				return (b.tv_fit_score ?? 0) - (a.tv_fit_score ?? 0);
			};
			return [...list].sort(sortFn);
		}

		if (sort === "score") list = [...list].sort((a, b) => (b.tv_fit_score ?? 0) - (a.tv_fit_score ?? 0));
		else if (sort === "price") list = [...list].sort((a, b) => (b.price_jpy ?? 0) - (a.price_jpy ?? 0));
		return list;
	}, [products, status, sort, isHomeShopping]);

	const counts = useMemo(() => {
		const total = products.length;
		const uncategorized = products.filter((p) => !(p as unknown as { user_action?: string }).user_action).length;
		const sourced = products.filter((p) => (p as unknown as { user_action?: string }).user_action === "sourced").length;
		return { total, uncategorized, sourced };
	}, [products]);
	const resultKey = `${context}|${status}|${sort}|${session?.id ?? "none"}`;
	const tier1Limit = limits.key === resultKey ? limits.tier1 : INITIAL_TIER_ROWS;
	const tier2Limit = limits.key === resultKey ? limits.tier2 : INITIAL_TIER_ROWS;
	const flatLimit = limits.key === resultKey ? limits.flat : INITIAL_FLAT_ROWS;

	const renderHomeProducts = () => {
		const tier1 = filtered.filter(
			(p) => (p as { tv_channel_source?: string | null }).tv_channel_source,
		);
		const tier2 = filtered.filter(
			(p) => !(p as { tv_channel_source?: string | null }).tv_channel_source,
		);
		return (
			<>
				{tier1.length > 0 && (
					<section className="mt-4">
						<h2 className="text-sm font-semibold text-foreground mb-2">
							{t("tvChannelSectionTitle")} ({tier1.length})
						</h2>
						<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
							{tier1.slice(0, tier1Limit).map((p) => (
								<ProductCard
									key={p.id}
									product={p}
									isSelected={selectedIds.has(p.id)}
									onToggleSelect={toggleSelect}
								/>
							))}
						</div>
						{tier1.length > tier1Limit && (
							<DiscoveryShowMore label={t("showMoreProducts", { count: Math.min(LOAD_MORE_PRODUCTS, tier1.length - tier1Limit) })} onClick={() => setLimits({ key: resultKey, tier1: tier1Limit + LOAD_MORE_PRODUCTS, tier2: tier2Limit, flat: flatLimit })} />
						)}
					</section>
				)}
				{tier2.length > 0 && (
					<section className="mt-6">
						<h2 className="text-sm font-semibold text-foreground mb-2">
							{t("otherSectionTitle")} ({tier2.length})
						</h2>
						<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
							{tier2.slice(0, tier2Limit).map((p) => (
								<ProductCard
									key={p.id}
									product={p}
									isSelected={selectedIds.has(p.id)}
									onToggleSelect={toggleSelect}
								/>
							))}
						</div>
						{tier2.length > tier2Limit && (
							<DiscoveryShowMore label={t("showMoreProducts", { count: Math.min(LOAD_MORE_PRODUCTS, tier2.length - tier2Limit) })} onClick={() => setLimits({ key: resultKey, tier1: tier1Limit, tier2: tier2Limit + LOAD_MORE_PRODUCTS, flat: flatLimit })} />
						)}
					</section>
				)}
				{filtered.length === 0 && (
					<div className="py-12 text-center text-sm text-muted-foreground">
						{t("noData")}
					</div>
				)}
			</>
		);
	};

	return (
		<div className="space-y-4">
			<ContextSubTabs />
			<div className="mw-toolbar">
				<div>
					<div className="mw-kicker mb-1">Daily candidate desk</div>
					<p className="text-xs text-muted-foreground sm:text-sm">
					{t("subtitle")} - {CONTEXT_LABEL[context]}
					</p>
				</div>
				{canManualTrigger && (
					<ManualTriggerButton context={context} onStarted={() => setTimeout(() => void query.mutate(), 180_000)} />
				)}
			</div>

			{loading ? (
				<div className="mw-empty-state">{t("loading")}</div>
			) : loadError ? (
				<div role="alert" className="mw-panel flex flex-col items-center justify-center gap-3 px-5 py-10 text-center">
					<AlertTriangle size={22} className="text-amber-600" />
					<p className="text-sm text-foreground">{loadError}</p>
					<button type="button" onClick={() => void query.mutate()} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium hover:bg-muted">
						<RefreshCw size={15} /> {t("retry")}
					</button>
				</div>
			) : (
				<>
					<DiscoveryHeader
						session={session}
						totalCount={counts.total}
						uncategorizedCount={counts.uncategorized}
						sourcedCount={counts.sourced}
					/>
					{isHomeShopping && (
						<CategoryFrequencyStrip
							stats={categoryStats}
							matchedCategories={matchedCategories}
						/>
					)}
					<DiscoveryFilters status={status} onStatusChange={setStatus} sort={sort} onSortChange={setSort} />
					{isHomeShopping ? (
						renderHomeProducts()
					) : (
						<section className="mt-2">
							<h2 className="mb-3 text-sm font-semibold text-foreground">{t("candidateList", { count: filtered.length })}</h2>
							<div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
								{filtered.slice(0, flatLimit).map((p) => (
									<ProductCard key={p.id} product={p} />
								))}
								{filtered.length === 0 && (
									<div className="col-span-full py-12 text-center text-sm text-muted-foreground">{t("noData")}</div>
								)}
							</div>
							{filtered.length > flatLimit && (
								<DiscoveryShowMore label={t("showMoreProducts", { count: Math.min(LOAD_MORE_PRODUCTS, filtered.length - flatLimit) })} onClick={() => setLimits({ key: resultKey, tier1: tier1Limit, tier2: tier2Limit, flat: flatLimit + LOAD_MORE_PRODUCTS })} />
							)}
						</section>
					)}
				</>
			)}
			{isHomeShopping && selectedIds.size >= 1 && (
					<div className="sticky bottom-3 left-0 right-0 z-20 mt-4 flex items-center justify-between rounded-xl border border-primary/25 bg-card/95 px-4 py-3 shadow-xl backdrop-blur">
					<span className="text-sm font-medium text-foreground">
						{t("selectionSelected", { count: selectedIds.size })}
					</span>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => setSelectedIds(new Set())}
							className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
						>
							{t("selectionClear")}
						</button>
						<button
							type="button"
							onClick={() => {
								const ids = [...selectedIds].join(",");
								router.push(
									localePath(locale, `/analytics/strategy/expansion?seedIds=${encodeURIComponent(ids)}`),
								);
							}}
							className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground hover:bg-primary/88"
						>
							<TrendingUp size={14} />
							{t("selectionOpenStrategy", { count: selectedIds.size })}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

function DiscoveryShowMore({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-xl border border-dashed border-border bg-muted/25 px-4 text-sm font-medium text-foreground hover:border-primary/40 hover:bg-primary/5">
			{label}
		</button>
	);
}
