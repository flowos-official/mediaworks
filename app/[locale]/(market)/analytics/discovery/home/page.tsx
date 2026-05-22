"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useParams, useRouter } from "next/navigation";
import { TrendingUp } from "lucide-react";
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

export default function DiscoveryHomePage() {
	const t = useTranslations("discovery");
	const [session, setSession] = useState<Session | null>(null);
	const [products, setProducts] = useState<DiscoveredProductRow[]>([]);
	const [categoryStats, setCategoryStats] = useState<CategoryStats | null>(null);
	const [loading, setLoading] = useState(true);
	const [status, setStatus] = useState<StatusFilter>("all");
	const [sort, setSort] = useState<SortKey>("score");
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const router = useRouter();
	const { locale } = useParams<{ locale: string }>();

	const toggleSelect = (id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const load = async () => {
		setLoading(true);
		const res = await fetch("/api/discovery/today?context=home_shopping");
		const data = await res.json();
		setSession(data.session);
		setProducts(data.products ?? []);
		setCategoryStats(data.categoryStats ?? null);
		setLoading(false);
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

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- async data fetch triggered on mount; setState calls are post-await
		load();
	}, []);

	const filtered = useMemo(() => {
		let list = products;
		if (status === "uncategorized") list = list.filter((p) => !(p as unknown as { user_action?: string }).user_action);
		else if (status !== "all")
			list = list.filter((p) => (p as unknown as { user_action?: string }).user_action === status);

		// Sort tier-first, then by user-chosen criterion inside each tier.
		const tierOf = (p: DiscoveredProductRow) =>
			(p as unknown as { tv_channel_source?: string | null }).tv_channel_source
				? 0
				: 1;
		const sortFn = (a: DiscoveredProductRow, b: DiscoveredProductRow) => {
			const ta = tierOf(a);
			const tb = tierOf(b);
			if (ta !== tb) return ta - tb;
			if (sort === "price") return (b.price_jpy ?? 0) - (a.price_jpy ?? 0);
			// score is the default
			return (b.tv_fit_score ?? 0) - (a.tv_fit_score ?? 0);
		};
		list = [...list].sort(sortFn);
		return list;
	}, [products, status, sort]);

	const counts = useMemo(() => {
		const total = products.length;
		const uncategorized = products.filter((p) => !(p as unknown as { user_action?: string }).user_action).length;
		const sourced = products.filter((p) => (p as unknown as { user_action?: string }).user_action === "sourced").length;
		return { total, uncategorized, sourced };
	}, [products]);

	return (
		<div>
			<ContextSubTabs />
			<div className="flex items-center justify-between mb-4 flex-wrap gap-2">
				<p className="text-sm text-muted-foreground">{t("subtitle")} — ホームショッピング</p>
				<ManualTriggerButton context="home_shopping" onStarted={() => setTimeout(load, 180_000)} />
			</div>

			{loading ? (
				<div className="py-20 text-center text-sm text-muted-foreground">{t("loading")}</div>
			) : (
				<>
					<DiscoveryHeader
						session={session}
						totalCount={counts.total}
						uncategorizedCount={counts.uncategorized}
						sourcedCount={counts.sourced}
					/>
					<CategoryFrequencyStrip
						stats={categoryStats}
						matchedCategories={matchedCategories}
					/>
					<DiscoveryFilters status={status} onStatusChange={setStatus} sort={sort} onSortChange={setSort} />
					{(() => {
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
										<h3 className="text-sm font-semibold text-foreground mb-2">
											{t("tvChannelSectionTitle")} ({tier1.length})
										</h3>
										<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
											{tier1.map((p) => (
												<ProductCard
													key={p.id}
													product={p}
													isSelected={selectedIds.has(p.id)}
													onToggleSelect={toggleSelect}
												/>
											))}
										</div>
									</section>
								)}
								{tier2.length > 0 && (
									<section className="mt-6">
										<h3 className="text-sm font-semibold text-foreground mb-2">
											{t("otherSectionTitle")} ({tier2.length})
										</h3>
										<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
											{tier2.map((p) => (
												<ProductCard
													key={p.id}
													product={p}
													isSelected={selectedIds.has(p.id)}
													onToggleSelect={toggleSelect}
												/>
											))}
										</div>
									</section>
								)}
								{filtered.length === 0 && (
									<div className="py-12 text-center text-sm text-muted-foreground">
										(no products match the current filter)
									</div>
								)}
							</>
						);
					})()}
				</>
			)}
			{selectedIds.size >= 1 && (
				<div className="sticky bottom-0 left-0 right-0 z-20 bg-card/95 border-t border-indigo-200 dark:border-indigo-900/40 px-4 py-3 mt-4 flex items-center justify-between shadow-lg backdrop-blur">
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
							className="inline-flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-lg"
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
