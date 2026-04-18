"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { TrendingUp, Radio } from "lucide-react";
import { SeedEnrichGateModal } from "./SeedEnrichGate";

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
	const router = useRouter();
	const [gateOpen, setGateOpen] = useState(false);

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

	const needGate = !hasCPackage && enrichmentStatus !== "completed";

	function handleClick() {
		if (needGate) {
			setGateOpen(true);
		} else {
			router.push(href);
		}
	}

	return (
		<>
			<button
				type="button"
				onClick={handleClick}
				className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 text-indigo-800 text-xs font-semibold rounded-lg transition-colors"
			>
				{icon}
				{label}
			</button>
			<SeedEnrichGateModal
				open={gateOpen}
				onClose={() => setGateOpen(false)}
				productId={productId}
				onDone={() => {
					setGateOpen(false);
					router.push(href);
				}}
				onSkip={() => {
					setGateOpen(false);
					router.push(href);
				}}
			/>
		</>
	);
}
