"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Search, ExternalLink, ChevronLeft, ChevronRight } from "lucide-react";
import type { HistoricalBroadcastRow } from "@/app/api/historical-broadcasts/route";
import {
	OA_CHANNELS,
	CHANNEL_BADGE,
	channelDisplayName,
} from "@/lib/broadcasts/channel-style";

interface Props {
	initialRows: HistoricalBroadcastRow[];
	initialTotal: number;
	channelCounts: Record<string, number>;
}

const PAGE_SIZE = 50;

function formatPrice(row: HistoricalBroadcastRow): string {
	if (row.price_jpy == null) return row.price_text ?? "—";
	const fmt = `¥${row.price_jpy.toLocaleString("ja-JP")}`;
	if (row.price_is_tax_incl === false) return `${fmt}（税抜）`;
	return fmt;
}

export default function HistoricalBroadcasts({
	initialRows,
	initialTotal,
	channelCounts,
}: Props) {
	const t = useTranslations("broadcasts.historical");

	const [channel, setChannel] = useState<string>("all");
	const [category] = useState<string>("all");
	const [search, setSearch] = useState("");
	const [searchInput, setSearchInput] = useState("");
	const [rows, setRows] = useState<HistoricalBroadcastRow[]>(initialRows);
	const [total, setTotal] = useState(initialTotal);
	const [offset, setOffset] = useState(0);
	const [loading, setLoading] = useState(false);

	const fetchPage = useCallback(
		async (
			nextChannel: string,
			nextCategory: string,
			nextSearch: string,
			nextOffset: number,
			signal?: AbortSignal,
		) => {
			setLoading(true);
			try {
				const qs = new URLSearchParams();
				if (nextSearch) qs.set("search", nextSearch);
				if (nextChannel !== "all") qs.set("channel", nextChannel);
				if (nextCategory !== "all") qs.set("category", nextCategory);
				qs.set("limit", String(PAGE_SIZE));
				qs.set("offset", String(nextOffset));
				const r = await fetch(`/api/historical-broadcasts?${qs}`, { signal });
				if (!r.ok) throw new Error(r.statusText);
				const json = (await r.json()) as {
					rows: HistoricalBroadcastRow[];
					total: number;
				};
				setRows(json.rows);
				setTotal(json.total);
			} catch (e) {
				if ((e as { name?: string }).name !== "AbortError") {
					console.error(e);
				}
			} finally {
				setLoading(false);
			}
		},
		[],
	);

	useEffect(() => {
		// Search-only mode: stay empty until the user enters a query (or
		// picks a channel chip). Skip the fetch entirely in the default
		// "no query, no chip" state so we never re-issue the SSR-equivalent
		// empty load.
		if (!search && channel === "all" && offset === 0) {
			return;
		}
		const ctrl = new AbortController();
		void fetchPage(channel, category, search, offset, ctrl.signal);
		return () => ctrl.abort();
	}, [channel, category, search, offset, fetchPage]);

	const handleChannelClick = (slug: string) => {
		setChannel(slug);
		setOffset(0);
	};

	const handleSearch = (e: React.FormEvent) => {
		e.preventDefault();
		setSearch(searchInput.trim());
		setOffset(0);
	};

	const totalPages = Math.ceil(total / PAGE_SIZE);
	const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
	const hasQuery = !!search || channel !== "all";

	return (
		<section className="mt-12 pt-8 border-t border-gray-200">
			<header className="mb-4">
				<h2 className="text-xl font-bold text-gray-900">{t("searchTitle")}</h2>
				<p className="text-sm text-gray-500 mt-1">{t("subtitle")}</p>
			</header>

			<div className="flex flex-wrap items-center gap-2 mb-4">
				<button
					type="button"
					onClick={() => handleChannelClick("all")}
					className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
						channel === "all"
							? "bg-gray-900 text-white border-gray-900"
							: "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
					}`}
				>
					{t("all")}
				</button>
				{OA_CHANNELS.map((c) => {
					const n = channelCounts[c.slug] ?? 0;
					const active = channel === c.slug;
					const colorClass =
						CHANNEL_BADGE[c.slug] ?? "bg-gray-100 text-gray-700 border-gray-200";
					return (
						<button
							key={c.slug}
							type="button"
							onClick={() => handleChannelClick(c.slug)}
							disabled={n === 0}
							className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
								active
									? "bg-gray-900 text-white border-gray-900"
									: n === 0
										? "bg-gray-50 text-gray-400 border-gray-200 cursor-not-allowed"
										: `${colorClass} hover:opacity-80`
							}`}
						>
							{c.name} ({n.toLocaleString("ja-JP")})
						</button>
					);
				})}
			</div>

			<form onSubmit={handleSearch} className="flex items-center gap-2 mb-5">
				<div className="flex-1 relative">
					<Search
						size={16}
						className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
					/>
					<input
						type="text"
						value={searchInput}
						onChange={(e) => setSearchInput(e.target.value)}
						placeholder={t("searchPlaceholder")}
						className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900 focus:border-gray-900"
					/>
				</div>
				<button
					type="submit"
					className="px-4 py-2 text-sm font-medium text-white bg-gray-900 rounded-lg hover:bg-gray-800"
				>
					{t("search")}
				</button>
				{search && (
					<button
						type="button"
						onClick={() => {
							setSearch("");
							setSearchInput("");
							setOffset(0);
						}}
						className="px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
					>
						{t("clear")}
					</button>
				)}
			</form>

			<div className="mb-3 text-xs text-gray-500">
				{loading
					? t("loading")
					: t("resultCount", { total: total.toLocaleString("ja-JP") })}
			</div>

			{rows.length === 0 ? (
				<div className="text-sm text-gray-500 p-12 text-center border border-dashed border-gray-200 rounded-lg">
					{hasQuery ? t("emptyForDate", { date: "" }) : t("emptyNoQuery")}
				</div>
			) : (
				<div className="border border-gray-200 rounded-lg overflow-hidden">
					<table className="w-full text-sm">
						<thead className="bg-gray-50 border-b border-gray-200">
							<tr>
								<th className="text-left px-3 py-2 font-medium text-gray-700 w-24">
									{t("col.date")}
								</th>
								<th className="text-left px-3 py-2 font-medium text-gray-700 w-32">
									{t("col.channel")}
								</th>
								<th className="text-left px-3 py-2 font-medium text-gray-700">
									{t("col.product")}
								</th>
								<th className="text-right px-3 py-2 font-medium text-gray-700 w-32">
									{t("col.price")}
								</th>
								<th className="w-8 px-3 py-2"></th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-100">
							{rows.map((r) => {
								const badge =
									CHANNEL_BADGE[r.channel as keyof typeof CHANNEL_BADGE] ??
									"bg-gray-100 text-gray-700 border-gray-200";
								return (
									<tr key={r.id} className="hover:bg-gray-50">
										<td className="px-3 py-2 text-gray-600 whitespace-nowrap">
											{r.air_date}
											{r.day_of_week ? (
												<span className="ml-1 text-gray-400">
													({r.day_of_week})
												</span>
											) : null}
										</td>
										<td className="px-3 py-2">
											<span
												className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${badge}`}
											>
												{channelDisplayName(r.channel)}
											</span>
										</td>
										<td className="px-3 py-2 text-gray-900">{r.product_name}</td>
										<td className="px-3 py-2 text-right text-gray-700 whitespace-nowrap">
											{formatPrice(r)}
										</td>
										<td className="px-3 py-2 text-right">
											{r.source_url && (
												<a
													href={r.source_url}
													target="_blank"
													rel="noopener noreferrer"
													className="inline-flex items-center text-gray-400 hover:text-gray-700"
													aria-label={t("col.openSource")}
												>
													<ExternalLink size={14} />
												</a>
											)}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			{totalPages > 1 && (
				<div className="flex items-center justify-between mt-4">
					<button
						type="button"
						onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
						disabled={offset === 0 || loading}
						className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
					>
						<ChevronLeft size={14} />
						{t("prev")}
					</button>
					<span className="text-xs text-gray-500">
						{t("page", {
							current: currentPage.toLocaleString("ja-JP"),
							total: totalPages.toLocaleString("ja-JP"),
						})}
					</span>
					<button
						type="button"
						onClick={() => setOffset(offset + PAGE_SIZE)}
						disabled={offset + PAGE_SIZE >= total || loading}
						className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border border-gray-300 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
					>
						{t("next")}
						<ChevronRight size={14} />
					</button>
				</div>
			)}
		</section>
	);
}
