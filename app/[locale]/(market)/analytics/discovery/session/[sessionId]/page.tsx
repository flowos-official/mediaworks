"use client";

import { useParams } from "next/navigation";
import { DiscoveryHeader } from "@/components/discovery/DiscoveryHeader";
import { ProductCard, type DiscoveredProductRow } from "@/components/discovery/ProductCard";
import { ContextSubTabs } from "@/components/discovery/ContextSubTabs";
import { useTranslations } from "next-intl";
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

export default function SessionDetailPage() {
	const t = useTranslations("discovery");
	const params = useParams<{ sessionId: string }>();
	const sessionId = params?.sessionId;
	const { data, isLoading: loading } = useApiQuery<{
		session: Session | null;
		products: DiscoveredProductRow[];
	}>(sessionId ? `/api/discovery/sessions/${sessionId}` : null);
	const session = data?.session ?? null;
	const products = data?.products ?? [];

	const counts = {
		total: products.length,
		uncategorized: products.filter((p) => !(p as unknown as { user_action?: string }).user_action).length,
		sourced: products.filter((p) => (p as unknown as { user_action?: string }).user_action === "sourced").length,
	};

	if (loading) return <div className="py-20 text-center text-sm text-muted-foreground" role="status">{t("loadingResults")}</div>;

	return (
		<div>
			<ContextSubTabs />
			<div className="mb-4">
				<p className="font-mono text-[10px] text-muted-foreground">{t("sessionLabel")}: {sessionId}</p>
			</div>
			<DiscoveryHeader
				session={session}
				totalCount={counts.total}
				uncategorizedCount={counts.uncategorized}
				sourcedCount={counts.sourced}
			/>
			<h2 className="mb-3 mt-5 text-sm font-semibold text-foreground">{t("sessionProductsTitle")} ({products.length})</h2>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-2">
				{products.map((p) => (
					<ProductCard key={p.id} product={p} />
				))}
				{products.length === 0 && (
					<div className="col-span-full py-12 text-center text-sm text-muted-foreground">
						{t("sessionEmpty")}
					</div>
				)}
			</div>
		</div>
	);
}
