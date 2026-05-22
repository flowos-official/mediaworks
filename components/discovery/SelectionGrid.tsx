"use client";
import { useEffect, useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import { ProductCard, type DiscoveredProductRow } from "./ProductCard";

type Status = "all" | "sourced" | "interested" | "rejected" | "duplicate";
type ContextFilter = "all" | "home_shopping" | "live_commerce";
type Period = 7 | 30 | 90;

export function SelectionGrid() {
	const t = useTranslations("discovery");
	const [status, setStatus] = useState<Status>("all");
	const [context, setContext] = useState<ContextFilter>("all");
	const [days, setDays] = useState<Period>(30);
	const [page, setPage] = useState(0);
	const [products, setProducts] = useState<DiscoveredProductRow[]>([]);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(false);

	const queryKey = useMemo(() => `${status}-${context}-${days}`, [status, context, days]);

	useEffect(() => {
		// eslint-disable-next-line react-hooks/set-state-in-effect -- initial load flag set synchronously before async fetch
		setLoading(true);
		const params = new URLSearchParams();
		if (status !== "all") params.set("status", status);
		if (context !== "all") params.set("context", context);
		params.set("days", String(days));
		params.set("page", String(page));
		params.set("limit", "20");

		fetch(`/api/discovery/selections?${params}`)
			.then((r) => r.json())
			.then((data) => {
				if (page === 0) setProducts(data.products ?? []);
				else setProducts((prev) => [...prev, ...(data.products ?? [])]);
				setTotal(data.total ?? 0);
				setLoading(false);
			})
			.catch(() => setLoading(false));
	}, [queryKey, page]);

	function updateStatus(s: Status) {
		setStatus(s);
		setPage(0);
	}
	function updateContext(c: ContextFilter) {
		setContext(c);
		setPage(0);
	}
	function updateDays(d: Period) {
		setDays(d);
		setPage(0);
	}

	return (
		<div>
			<div className="flex flex-wrap items-center gap-2 mb-4">
				<span className="text-xs text-muted-foreground">Status:</span>
				{(["all", "sourced", "interested", "rejected", "duplicate"] as Status[]).map((s) => (
					<button
						key={s}
						onClick={() => updateStatus(s)}
						className={`px-3 py-1 text-xs rounded-full border transition-colors ${
							status === s
								? "bg-amber-500 text-white border-amber-500"
								: "bg-card text-foreground border-border hover:bg-muted"
						}`}
					>
						{s === "all"
							? t("allStatuses")
							: s === "sourced"
							? t("filterSourced")
							: s === "interested"
							? t("filterInterested")
							: s === "rejected"
							? t("filterRejected")
							: t("duplicateButton")}
					</button>
				))}
				<span className="text-xs text-muted-foreground ml-2">Context:</span>
				{(["all", "home_shopping", "live_commerce"] as ContextFilter[]).map((c) => (
					<button
						key={c}
						onClick={() => updateContext(c)}
						className={`px-3 py-1 text-xs rounded-full border transition-colors ${
							context === c
								? "bg-blue-500 text-white border-blue-500"
								: "bg-card text-foreground border-border hover:bg-muted"
						}`}
					>
						{c === "all" ? t("allStatuses") : c === "home_shopping" ? "ホーム" : "ライブ"}
					</button>
				))}
				<span className="text-xs text-muted-foreground ml-2">Period:</span>
				{([7, 30, 90] as Period[]).map((d) => (
					<button
						key={d}
						onClick={() => updateDays(d)}
						className={`px-3 py-1 text-xs rounded-full border transition-colors ${
							days === d
								? "bg-gray-600 text-white border-gray-600"
								: "bg-card text-foreground border-border hover:bg-muted"
						}`}
					>
						{t(d === 7 ? "periodFilter7" : d === 30 ? "periodFilter30" : "periodFilter90")}
					</button>
				))}
				<span className="ml-auto text-xs text-muted-foreground">{products.length}/{total}</span>
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

			{loading && <div className="py-8 text-center text-sm text-muted-foreground">Loading...</div>}

			{!loading && products.length < total && (
				<div className="py-4 text-center">
					<button
						onClick={() => setPage((p) => p + 1)}
						className="px-6 py-2 text-xs border border-border rounded hover:bg-muted"
					>
						{t("loadMore")}
					</button>
				</div>
			)}
		</div>
	);
}
