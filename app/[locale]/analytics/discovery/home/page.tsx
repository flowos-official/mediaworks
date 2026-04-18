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
		load();
	}, []);

	const filtered = useMemo(() => {
		let list = products;
		if (status === "uncategorized") list = list.filter((p) => !(p as unknown as { user_action?: string }).user_action);
		else if (status !== "all")
			list = list.filter((p) => (p as unknown as { user_action?: string }).user_action === status);
		if (sort === "score") list = [...list].sort((a, b) => (b.tv_fit_score ?? 0) - (a.tv_fit_score ?? 0));
		else if (sort === "price") list = [...list].sort((a, b) => (b.price_jpy ?? 0) - (a.price_jpy ?? 0));
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
					<div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-2">
						{filtered.map((p) => (
							<ProductCard key={p.id} product={p} />
						))}
						{filtered.length === 0 && (
							<div className="col-span-full py-12 text-center text-sm text-gray-400">
								(no products match the current filter)
							</div>
						)}
					</div>
				</>
			)}
		</div>
	);
}
