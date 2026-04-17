"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import Navbar from "@/components/Navbar";
import { DiscoveryHeader } from "@/components/discovery/DiscoveryHeader";
import { ProductCard, type DiscoveredProductRow } from "@/components/discovery/ProductCard";

type Session = {
	id: string;
	run_at: string;
	completed_at: string | null;
	status: "running" | "completed" | "partial" | "failed";
	target_count: number;
	produced_count: number;
	iterations: number;
};

export default function SessionDetailPage() {
	const t = useTranslations("discovery");
	const params = useParams<{ sessionId: string }>();
	const sessionId = params?.sessionId;
	const [session, setSession] = useState<Session | null>(null);
	const [products, setProducts] = useState<DiscoveredProductRow[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!sessionId) return;
		let cancelled = false;
		async function load() {
			setLoading(true);
			const res = await fetch(`/api/discovery/sessions/${sessionId}`);
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
	}, [sessionId]);

	const counts = {
		total: products.length,
		uncategorized: products.filter(
			(p) => !(p as unknown as { user_action?: string }).user_action,
		).length,
		sourced: products.filter(
			(p) => (p as unknown as { user_action?: string }).user_action === "sourced",
		).length,
	};

	return (
		<div className="min-h-screen bg-gray-50">
			<Navbar />
			<main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
				<header className="mb-6">
					<h1 className="text-2xl font-bold text-gray-900 mb-1">{t("title")}</h1>
					<p className="text-xs text-gray-500">session: {sessionId}</p>
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

						<div className="space-y-3">
							{products.map((p) => (
								<ProductCard key={p.id} product={p} />
							))}
							{products.length === 0 && (
								<div className="py-12 text-center text-sm text-gray-400">
									(no products in this session)
								</div>
							)}
						</div>
					</>
				)}
			</main>
		</div>
	);
}
