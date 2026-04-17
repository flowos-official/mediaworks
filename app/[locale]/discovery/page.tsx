"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import Navbar from "@/components/Navbar";
import { DiscoveryHeader } from "@/components/discovery/DiscoveryHeader";
import { ProductCard, type DiscoveredProductRow } from "@/components/discovery/ProductCard";
import {
	DiscoveryFilters,
	type SortKey,
	type StatusFilter,
} from "@/components/discovery/DiscoveryFilters";

type Session = {
	id: string;
	run_at: string;
	completed_at: string | null;
	status: "running" | "completed" | "partial" | "failed";
	target_count: number;
	produced_count: number;
	iterations: number;
};

export default function DiscoveryPage() {
	const t = useTranslations("discovery");
	const [session, setSession] = useState<Session | null>(null);
	const [products, setProducts] = useState<DiscoveredProductRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [status, setStatus] = useState<StatusFilter>("all");
	const [sort, setSort] = useState<SortKey>("score");

	useEffect(() => {
		let cancelled = false;
		async function load() {
			setLoading(true);
			const res = await fetch("/api/discovery/today");
			const data = await res.json();
			if (!cancelled) {
				setSession(data.session);
				setProducts(data.products ?? []);
				setLoading(false);
			}
		}
		load();
		return () => {
			cancelled = true;
		};
	}, []);

	const filtered = useMemo(() => {
		let list = products;
		if (status === "uncategorized") list = list.filter((p) => !p.id || !("user_action" in p) || !(p as unknown as { user_action?: string }).user_action);
		else if (status !== "all")
			list = list.filter((p) => (p as unknown as { user_action?: string }).user_action === status);
		if (sort === "score") list = [...list].sort((a, b) => (b.tv_fit_score ?? 0) - (a.tv_fit_score ?? 0));
		else if (sort === "price") list = [...list].sort((a, b) => (b.price_jpy ?? 0) - (a.price_jpy ?? 0));
		return list;
	}, [products, status, sort]);

	const counts = useMemo(() => {
		const total = products.length;
		const uncategorized = products.filter(
			(p) => !(p as unknown as { user_action?: string }).user_action,
		).length;
		const sourced = products.filter(
			(p) => (p as unknown as { user_action?: string }).user_action === "sourced",
		).length;
		return { total, uncategorized, sourced };
	}, [products]);

	return (
		<div className="min-h-screen bg-gray-50">
			<Navbar />
			<main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
				<header className="mb-6">
					<h1 className="text-2xl font-bold text-gray-900 mb-1">{t("title")}</h1>
					<p className="text-sm text-gray-500">{t("subtitle")}</p>
				</header>

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

						<DiscoveryFilters
							status={status}
							onStatusChange={setStatus}
							sort={sort}
							onSortChange={setSort}
						/>

						<div className="space-y-3">
							{filtered.map((p) => (
								<ProductCard key={p.id} product={p} />
							))}
							{filtered.length === 0 && (
								<div className="py-12 text-center text-sm text-gray-400">
									(no products match the current filter)
								</div>
							)}
						</div>
					</>
				)}
			</main>
		</div>
	);
}
