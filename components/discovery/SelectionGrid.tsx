"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import useSWRInfinite from "swr/infinite";
import { ProductCard, type DiscoveredProductRow } from "./ProductCard";
import { apiJsonFetcher } from "@/lib/client/api-cache";

type Status = "all" | "sourced" | "interested" | "rejected" | "duplicate";
type ContextFilter = "all" | "home_shopping" | "live_commerce";
type Period = 7 | 30 | 90;

export function SelectionGrid() {
	const t = useTranslations("discovery");
	const [status, setStatus] = useState<Status>("all");
	const [context, setContext] = useState<ContextFilter>("all");
	const [days, setDays] = useState<Period>(30);
	const getKey = (page: number) => {
		const params = new URLSearchParams();
		if (status !== "all") params.set("status", status);
		if (context !== "all") params.set("context", context);
		params.set("days", String(days));
		params.set("page", String(page));
		params.set("limit", "20");
		return `/api/discovery/selections?${params}`;
	};
	const { data, size, setSize, isLoading, isValidating } = useSWRInfinite<{
		products: DiscoveredProductRow[];
		total: number;
	}>(getKey, apiJsonFetcher, { revalidateFirstPage: false });
	const products = data?.flatMap((page) => page.products ?? []) ?? [];
	const total = data?.[0]?.total ?? 0;
	const loading = isLoading || (isValidating && !data?.[size - 1]);

	function updateStatus(s: Status) {
		setStatus(s);
	}
	function updateContext(c: ContextFilter) {
		setContext(c);
	}
	function updateDays(d: Period) {
		setDays(d);
	}

	return (
		<div>
			<div className="mb-3 flex items-end justify-between gap-3">
				<div>
					<div className="mw-kicker mb-1">Discovery decisions</div>
					<h2 className="mw-section-title">{t("insightsResultsTitle")}</h2>
				</div>
				<span className="font-mono text-[10px] text-muted-foreground">{products.length}/{total}</span>
			</div>

			<div className="mw-toolbar mb-4 items-start">
				<fieldset className="flex min-w-0 flex-wrap gap-1.5">
					<legend className="mb-1 w-full text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t("statusFilterLabel")}</legend>
					{(["all", "sourced", "interested", "rejected", "duplicate"] as Status[]).map((s) => (
						<button
							type="button"
							key={s}
							onClick={() => updateStatus(s)}
							className={`min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${status === s ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:bg-muted"}`}
						>
							{s === "all" ? t("allStatuses") : s === "sourced" ? t("filterSourced") : s === "interested" ? t("filterInterested") : s === "rejected" ? t("filterRejected") : t("duplicateButton")}
						</button>
					))}
				</fieldset>
				<fieldset className="flex min-w-0 flex-wrap gap-1.5">
					<legend className="mb-1 w-full text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t("contextFilterLabel")}</legend>
					{(["all", "home_shopping", "live_commerce"] as ContextFilter[]).map((c) => (
						<button type="button" key={c} onClick={() => updateContext(c)} className={`min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${context === c ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:bg-muted"}`}>
							{c === "all" ? t("allStatuses") : c === "home_shopping" ? "ホーム" : "ライブ"}
						</button>
					))}
				</fieldset>
				<fieldset className="flex min-w-0 flex-wrap gap-1.5">
					<legend className="mb-1 w-full text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{t("periodFilterLabel")}</legend>
					{([7, 30, 90] as Period[]).map((d) => (
						<button type="button" key={d} onClick={() => updateDays(d)} className={`min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${days === d ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:bg-muted"}`}>
							{t(d === 7 ? "periodFilter7" : d === 30 ? "periodFilter30" : "periodFilter90")}
						</button>
					))}
				</fieldset>
			</div>

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
				{products.map((p) => (
					<ProductCard key={p.id} product={p} />
				))}
				{products.length === 0 && !loading && (
					<div className="col-span-full py-12 text-center text-sm text-muted-foreground">
						{t("noData")}
					</div>
				)}
			</div>

			{loading && <div className="py-8 text-center text-sm text-muted-foreground" role="status">{t("loadingResults")}</div>}

			{!loading && products.length < total && (
				<div className="py-4 text-center">
					<button
						type="button"
					onClick={() => void setSize((current) => current + 1)}
						className="px-6 py-2 text-xs border border-border rounded hover:bg-muted"
					>
						{t("loadMore")}
					</button>
				</div>
			)}
		</div>
	);
}
