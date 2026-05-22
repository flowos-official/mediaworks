"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { TrendingUp, Radio } from "lucide-react";
import { SeedEnrichGateModal } from "./SeedEnrichGate";
import { localePath } from "@/lib/i18n/locale-path";

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
	const [promoting, setPromoting] = useState(false);
	const [promoteError, setPromoteError] = useState<string | null>(null);

	const targetPath =
		context === "live_commerce"
			? localePath(locale, "/analytics/strategy/live")
			: localePath(locale, "/analytics/strategy/expansion");

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
	const canPromote = enrichmentStatus === "completed";

	function handleClick() {
		if (needGate) {
			setGateOpen(true);
		} else {
			router.push(href);
		}
	}

	async function handlePromote() {
		if (!canPromote || promoting) return;
		setPromoting(true);
		setPromoteError(null);
		try {
			const res = await fetch(`/api/discovery/${productId}/promote-to-research`, {
				method: "POST",
			});
			const json = await res.json();
			if (!res.ok) {
				setPromoteError(json.error ?? "promotion failed");
				return;
			}
			router.push(localePath(locale, `/products/${json.productId}`));
		} catch (err) {
			setPromoteError(err instanceof Error ? err.message : "unexpected error");
		} finally {
			setPromoting(false);
		}
	}

	return (
		<>
			<button
				type="button"
				onClick={handleClick}
				className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600/10 hover:bg-indigo-600/15 border border-indigo-200 text-indigo-800 text-xs font-semibold rounded-lg transition-colors"
			>
				{icon}
				{label}
			</button>
			<button
				type="button"
				onClick={handlePromote}
				disabled={!canPromote || promoting}
				className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 mt-2 bg-emerald-600/10 hover:bg-emerald-600/15 border border-emerald-200 text-emerald-800 text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
			>
				{promoting ? "リサーチ作成中…" : "リサーチ実施"}
			</button>
			{promoteError ? (
				<p className="mt-1 text-xs text-red-600">{promoteError}</p>
			) : null}
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
