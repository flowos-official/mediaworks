"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { TrendingUp, Radio } from "lucide-react";
import { SeedEnrichGate } from "./SeedEnrichGate";

interface Props {
	productId: string;
	context: "home_shopping" | "live_commerce";
	productName: string;
	category: string | null;
	productUrl: string;
	priceJpy: number | null;
	enrichmentStatus: "idle" | "queued" | "running" | "completed" | "failed";
	hasCPackage: boolean;
}

export function IntegrationActions({
	productId,
	context,
	productName,
	category,
	productUrl,
	priceJpy,
	enrichmentStatus,
	hasCPackage,
}: Props) {
	const t = useTranslations("discovery");
	const { locale } = useParams<{ locale: string }>();

	const targetPath =
		context === "live_commerce"
			? `/${locale}/analytics/strategy/live`
			: `/${locale}/analytics/strategy/expansion`;

	const params = new URLSearchParams();
	params.set("seedId", productId);
	params.set("seed", productName);
	if (category) params.set("category", category);
	if (productUrl) params.set("sourceUrl", productUrl);
	if (priceJpy) params.set("price", String(priceJpy));

	const href = `${targetPath}?${params.toString()}`;

	const label =
		context === "live_commerce" ? t("viewLiveStrategy") : t("viewStrategy");
	const icon =
		context === "live_commerce" ? <Radio size={12} /> : <TrendingUp size={12} />;

	return (
		<SeedEnrichGate
			productId={productId}
			enrichmentStatus={enrichmentStatus}
			hasCPackage={hasCPackage}
			targetHref={href}
		>
			<Link
				href={href}
				className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-800 text-xs font-semibold rounded-lg transition-colors"
			>
				{icon}
				{label}
			</Link>
		</SeedEnrichGate>
	);
}
