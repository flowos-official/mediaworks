"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Search, ExternalLink, ChevronLeft, ChevronRight } from "lucide-react";
import type { HistoricalBroadcastRow } from "@/app/api/historical-broadcasts/route";
import type { Broadcast } from "./BroadcastListItem";
import {
	ALL_CHANNELS,
	CHANNEL_BADGE,
	channelDisplayName,
} from "@/lib/broadcasts/channel-style";

interface Props {
	channelCounts: Record<string, number>;
}

const PAGE_SIZE = 100;

// Unified row shape merging broadcasts (QVC/ShopCh) and historical_broadcasts (10 OA).
interface UnifiedRow {
	id: string;
	channel: string;
	air_date: string;
	day_of_week: string | null;
	name: string;
	priceText: string | null;
	source_url: string | null;
	category: string | null;
}

function formatHistoricalPrice(row: HistoricalBroadcastRow): string {
	if (row.price_jpy == null) return row.price_text ?? "—";
	const fmt = `¥${row.price_jpy.toLocaleString("ja-JP")}`;
	if (row.price_is_tax_incl === false) return `${fmt}（税抜）`;
	return fmt;
}

function broadcastToUnified(b: Broadcast): UnifiedRow {
	return {
		id: `b:${b.id}`,
		channel: b.channel,
		air_date: b.air_date,
		day_of_week: null,
		name: b.program_title,
		priceText: null,
		source_url: b.source_url,
		category: b.category ?? null,
	};
}

function historicalToUnified(r: HistoricalBroadcastRow): UnifiedRow {
	return {
		id: `h:${r.id}`,
		channel: r.channel,
		air_date: r.air_date,
		day_of_week: r.day_of_week,
		name: r.product_name,
		priceText: formatHistoricalPrice(r),
		source_url: r.source_url,
		category: r.category,
	};
}

function isOAChannelSlug(slug: string): boolean {
	return slug !== "qvc" && slug !== "shopch";
}

export default function HistoricalBroadcasts({ channelCounts }: Props) {
	const t = useTranslations("broadcasts.historical");

	const [channel, setChannel] = useState<string>("all");
	const [search, setSearch] = useState("");
	const [searchInput, setSearchInput] = useState("");
	const [rows, setRows] = useState<UnifiedRow[]>([]);
	const [total, setTotal] = useState(0);
	const [offset, setOffset] = useState(0);
	const [loading, setLoading] = useState(false);

	const fetchPage = useCallback(
		async (
			nextChannel: string,
			nextSearch: string,
			nextOffset: number,
			signal?: AbortSignal,
		) => {
			setLoading(true);
			try {
				const queryBroadcasts =
					nextChannel === "all" ||
					nextChannel === "qvc" ||
					nextChannel === "shopch";
				const queryHistorical =
					nextChannel === "all" || isOAChannelSlug(nextChannel);

				const broadcastsQs = new URLSearchParams();
				if (nextSearch) broadcastsQs.set("search", nextSearch);
				if (nextChannel !== "all" && !isOAChannelSlug(nextChannel)) {
					broadcastsQs.set("channel", nextChannel);
				}
				broadcastsQs.set("limit", String(PAGE_SIZE));
				broadcastsQs.set("offset", String(nextOffset));

				const historicalQs = new URLSearchParams();
				if (nextSearch) historicalQs.set("search", nextSearch);
				if (nextChannel !== "all" && isOAChannelSlug(nextChannel)) {
					historicalQs.set("channel", nextChannel);
				}
				historicalQs.set("limit", String(PAGE_SIZE));
				historicalQs.set("offset", String(nextOffset));

				const [bRes, hRes] = await Promise.allSettled([
					queryBroadcasts
						? fetch(`/api/broadcasts?${broadcastsQs}`, { signal })
						: Promise.resolve(null),
					queryHistorical
						? fetch(`/api/historical-broadcasts?${historicalQs}`, { signal })
						: Promise.resolve(null),
				]);

				const merged: UnifiedRow[] = [];
				let totalCount = 0;

				if (
					bRes.status === "fulfilled" &&
					bRes.value &&
					bRes.value.ok
				) {
					const json = (await bRes.value.json()) as {
						broadcasts: Broadcast[];
						total: number;
					};
					for (const b of json.broadcasts ?? []) {
						merged.push(broadcastToUnified(b));
					}
					totalCount += json.total ?? 0;
				}
				if (
					hRes.status === "fulfilled" &&
					hRes.value &&
					hRes.value.ok
				) {
					const json = (await hRes.value.json()) as {
						rows: HistoricalBroadcastRow[];
						total: number;
					};
					for (const r of json.rows ?? []) {
						merged.push(historicalToUnified(r));
					}
					totalCount += json.total ?? 0;
				}

				merged.sort((a, b) => {
					if (a.air_date !== b.air_date) return b.air_date.localeCompare(a.air_date);
					return a.channel.localeCompare(b.channel);
				});
				setRows(merged);
				setTotal(totalCount);
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
		// Search-only mode: stay empty until the user enters a query or picks a channel chip.
		if (!search && channel === "all" && offset === 0) {
			return;
		}
		const ctrl = new AbortController();
		const timer = window.setTimeout(
			() => void fetchPage(channel, search, offset, ctrl.signal),
			0,
		);
		return () => {
			window.clearTimeout(timer);
			ctrl.abort();
		};
	}, [channel, search, offset, fetchPage]);

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
		<section>
			<header className="mb-4 pt-4">
				<p className="text-sm text-muted-foreground">{t("subtitle")}</p>
			</header>

			<div className="flex flex-wrap items-center gap-2 mb-4">
				<button
					type="button"
					onClick={() => handleChannelClick("all")}
					className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
						channel === "all"
							? "bg-foreground text-background border-foreground"
							: "bg-card text-foreground border-border hover:bg-muted"
					}`}
				>
					{t("all")}
				</button>
				{ALL_CHANNELS.map((c) => {
					const n = channelCounts[c.slug] ?? 0;
					const active = channel === c.slug;
					const colorClass =
						CHANNEL_BADGE[c.slug] ?? "bg-muted text-foreground border-border";
					return (
						<button
							key={c.slug}
							type="button"
							onClick={() => handleChannelClick(c.slug)}
							disabled={n === 0}
							className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
								active
									? "bg-foreground text-background border-foreground"
									: n === 0
										? "bg-muted text-muted-foreground border-border cursor-not-allowed"
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
						className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
					/>
					<input
						type="text"
						value={searchInput}
						onChange={(e) => setSearchInput(e.target.value)}
						placeholder={t("searchPlaceholder")}
						className="w-full pl-9 pr-3 py-2 text-sm border border-border bg-background text-foreground rounded-lg focus:outline-none focus:ring-2 focus:ring-foreground focus:border-foreground"
					/>
				</div>
				<button
					type="submit"
					className="px-4 py-2 text-sm font-medium text-background bg-foreground rounded-lg hover:bg-foreground/90"
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
						className="px-3 py-2 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted"
					>
						{t("clear")}
					</button>
				)}
			</form>

			<div className="mb-3 text-xs text-muted-foreground">
				{loading
					? t("loading")
					: t("resultCount", { total: total.toLocaleString("ja-JP") })}
			</div>

			{rows.length === 0 ? (
				<div className="text-sm text-muted-foreground p-12 text-center border border-dashed border-border rounded-lg">
					{hasQuery ? t("emptyForDate", { date: "" }) : t("emptyNoQuery")}
				</div>
			) : (
				<div className="border border-border rounded-lg overflow-hidden">
					<table className="w-full text-sm">
						<thead className="bg-muted border-b border-border">
							<tr>
								<th className="text-left px-3 py-2 font-medium text-foreground w-24">
									{t("col.date")}
								</th>
								<th className="text-left px-3 py-2 font-medium text-foreground w-32">
									{t("col.channel")}
								</th>
								<th className="text-left px-3 py-2 font-medium text-foreground">
									{t("col.product")}
								</th>
								<th className="text-right px-3 py-2 font-medium text-foreground w-32">
									{t("col.price")}
								</th>
								<th className="w-8 px-3 py-2"></th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border">
							{rows.map((r) => {
								const badge =
									CHANNEL_BADGE[r.channel as keyof typeof CHANNEL_BADGE] ??
									"bg-muted text-foreground border-border";
								return (
									<tr key={r.id} className="hover:bg-muted">
										<td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
											{r.air_date}
											{r.day_of_week ? (
												<span className="ml-1 text-muted-foreground/70">
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
										<td className="px-3 py-2 text-foreground">{r.name}</td>
										<td className="px-3 py-2 text-right text-foreground whitespace-nowrap">
											{r.priceText ?? "—"}
										</td>
										<td className="px-3 py-2 text-right">
											{r.source_url && (
												<a
													href={r.source_url}
													target="_blank"
													rel="noopener noreferrer"
													className="inline-flex items-center text-muted-foreground hover:text-foreground"
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
						className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border border-border rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-muted"
					>
						<ChevronLeft size={14} />
						{t("prev")}
					</button>
					<span className="text-xs text-muted-foreground">
						{t("page", {
							current: currentPage.toLocaleString("ja-JP"),
							total: totalPages.toLocaleString("ja-JP"),
						})}
					</span>
					<button
						type="button"
						onClick={() => setOffset(offset + PAGE_SIZE)}
						disabled={offset + PAGE_SIZE >= total || loading}
						className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border border-border rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-muted"
					>
						{t("next")}
						<ChevronRight size={14} />
					</button>
				</div>
			)}
		</section>
	);
}
