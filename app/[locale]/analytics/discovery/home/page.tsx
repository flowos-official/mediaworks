"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { DiscoveryHeader } from "@/components/discovery/DiscoveryHeader";
import { ProductCard, type DiscoveredProductRow } from "@/components/discovery/ProductCard";
import {
	DiscoveryFilters,
	type SortKey,
	type StatusFilter,
} from "@/components/discovery/DiscoveryFilters";
import { ContextSubTabs } from "@/components/discovery/ContextSubTabs";
import { ManualTriggerButton } from "@/components/discovery/ManualTriggerButton";

type Session = {
	id: string;
	run_at: string;
	completed_at: string | null;
	status: "running" | "completed" | "partial" | "failed";
	target_count: number;
	produced_count: number;
	iterations: number;
};

export default function DiscoveryHomePage() {
	const t = useTranslations("discovery");
	const [session, setSession] = useState<Session | null>(null);
	const [products, setProducts] = useState<DiscoveredProductRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [status, setStatus] = useState<StatusFilter>("all");
	const [sort, setSort] = useState<SortKey>("score");

	const load = async () => {
		setLoading(true);
		const res = await fetch("/api/discovery/today?context=home_shopping");
		const data = await res.json();
		setSession(data.session);
		setProducts(data.products ?? []);
		setLoading(false);
	};

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
				<p className="text-sm text-gray-500">{t("subtitle")} — ホームショッピング</p>
				<ManualTriggerButton context="home_shopping" onStarted={() => setTimeout(load, 180_000)} />
			</div>

			{loading ? (
				<div className="py-20 text-center text-sm text-gray-500">Loading...</div>
			) : (
				<>
					<DiscoveryHeader
						session={session}
						totalCount={counts.total}
						uncategorizedCount={counts.uncategorized}
						sourcedCount={counts.sourced}
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
										<h3 className="text-sm font-semibold text-gray-800 mb-2">
											{t("tvChannelSectionTitle")} ({tier1.length})
										</h3>
										<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
											{tier1.map((p) => (
												<ProductCard key={p.id} product={p} />
											))}
										</div>
									</section>
								)}
								{tier2.length > 0 && (
									<section className="mt-6">
										<h3 className="text-sm font-semibold text-gray-800 mb-2">
											{t("otherSectionTitle")} ({tier2.length})
										</h3>
										<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
											{tier2.map((p) => (
												<ProductCard key={p.id} product={p} />
											))}
										</div>
									</section>
								)}
								{filtered.length === 0 && (
									<div className="py-12 text-center text-sm text-gray-400">
										(no products match the current filter)
									</div>
								)}
							</>
						);
					})()}
				</>
			)}
		</div>
	);
}
