"use client";

import { useDeferredValue, useState } from "react";
import { useTranslations } from "next-intl";
import { Clock3, Search, Tv, X } from "lucide-react";
import BroadcastListItem, {
	type Broadcast,
} from "./BroadcastListItem";
import OABroadcastListItem, { type OARow } from "./OABroadcastListItem";
import BroadcastVideoModal from "./BroadcastVideoModal";
import {
	ALL_CHANNELS,
	CHANNEL_BADGE,
	type BroadcastChannelSlug,
} from "@/lib/broadcasts/channel-style";
import { CATEGORIES_BY_CHANNEL, isWhitelistedSlot } from "@/lib/broadcasts/whitelist-gate";
import { useApiQuery } from "@/lib/client/api-cache";

interface Props {
	date: string | null;
}

const INITIAL_TIMED_ROWS = 10;
const INITIAL_OA_ROWS = 16;
const LOAD_MORE_ROWS = 16;

function formatDateLabel(iso: string): string {
	const [y, m, d] = iso.split("-");
	return `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
	weekday: "long",
	timeZone: "Asia/Tokyo",
});

function formatWeekday(iso: string): string {
	return WEEKDAY_FORMATTER.format(new Date(`${iso}T00:00:00+09:00`));
}

export default function UnifiedDayDetailPanel({ date }: Props) {
	const t = useTranslations("broadcasts");
	const [channelFilter, setChannelFilter] = useState<string>("all");
	const [categoryFilter, setCategoryFilter] = useState<string>("all");
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase("ja"));
	const [limits, setLimits] = useState({ key: "", timed: INITIAL_TIMED_ROWS, oa: INITIAL_OA_ROWS });
	const [modalBroadcast, setModalBroadcast] = useState<Broadcast | null>(null);
	const timedQuery = useApiQuery<{ broadcasts: Broadcast[] }>(
		date ? `/api/broadcasts?from=${date}&to=${date}` : null,
	);
	const oaQuery = useApiQuery<{ rows: OARow[] }>(
		date ? `/api/historical-broadcasts?date=${date}&limit=500` : null,
	);
	const timedRows = timedQuery.data?.broadcasts ?? [];
	const oaRows = oaQuery.data?.rows ?? [];
	const timedError = Boolean(timedQuery.error);
	const oaError = Boolean(oaQuery.error);
	const loading = Boolean(date) && (timedQuery.isLoading || oaQuery.isLoading);
	const hasFetchError = timedError || oaError;

	if (!date) {
		return (
			<div className="mw-empty-state border-0 bg-transparent">
				{t("empty.day")}
			</div>
		);
	}

	const matchesFilters = (channel: string, category: string | null): boolean => {
		if (channelFilter !== "all" && channel !== channelFilter) return false;
		if (!isWhitelistedSlot(channel, category)) return false;
		if (categoryFilter === "all") return true;
		return category === categoryFilter;
	};
	const includesQuery = (...values: Array<string | null | undefined>) =>
		!deferredQuery || values.some((value) => value?.toLocaleLowerCase("ja").includes(deferredQuery));
	const filteredTimed = timedRows.filter((b) =>
		matchesFilters(b.channel, b.category ?? null) && includesQuery(
			b.program_title,
			b.description,
			b.presenter,
			b.brand_name,
			b.category,
			...(b.products?.map((product) => product.name) ?? []),
		),
	);
	const filteredOA = oaRows.filter((r) =>
		matchesFilters(r.channel, r.category) && includesQuery(
			r.product_name,
			r.category,
			r.price_text,
		),
	);
	const totalShown = filteredTimed.length + filteredOA.length;
	const hasActiveFilters = channelFilter !== "all" || categoryFilter !== "all" || query.length > 0;

	const channelCount = (slug: string): number => {
		const fromTimed = timedRows.filter(
			(b) =>
				b.channel === slug &&
				isWhitelistedSlot(b.channel, b.category ?? null) &&
				(categoryFilter === "all" || b.category === categoryFilter),
		).length;
		const fromOA = oaRows.filter(
			(r) =>
				r.channel === slug &&
				isWhitelistedSlot(r.channel, r.category) &&
				(categoryFilter === "all" || r.category === categoryFilter),
		).length;
		return fromTimed + fromOA;
	};

	const showCategoryChips =
		channelFilter === "qvc" || channelFilter === "shopch";
	const visibleCategories: readonly string[] = showCategoryChips
		? CATEGORIES_BY_CHANNEL[channelFilter as "qvc" | "shopch"]
		: [];

	const sortedTimed = [...filteredTimed].sort((a, b) => {
		if (a.start_time !== b.start_time)
			return a.start_time.localeCompare(b.start_time);
		return a.channel.localeCompare(b.channel);
	});
	const resultKey = `${date}|${channelFilter}|${categoryFilter}|${deferredQuery}`;
	const timedLimit = limits.key === resultKey ? limits.timed : INITIAL_TIMED_ROWS;
	const oaLimit = limits.key === resultKey ? limits.oa : INITIAL_OA_ROWS;
	const visibleTimed = sortedTimed.slice(0, timedLimit);
	const visibleOA = filteredOA.slice(0, oaLimit);

	const oaByChannel = new Map<string, OARow[]>();
	for (const row of visibleOA) {
		const list = oaByChannel.get(row.channel) ?? [];
		list.push(row);
		oaByChannel.set(row.channel, list);
	}

	return (
		<div>
			<BroadcastVideoModal
				broadcastId={modalBroadcast?.id ?? null}
				videoKey={modalBroadcast?.archived_video_s3 ?? null}
				brandName={modalBroadcast?.brand_name ?? null}
				onClose={() => setModalBroadcast(null)}
			/>
			<div className="mb-3 border-b border-border pb-3 xl:sticky xl:-top-4 xl:z-10 xl:-mx-4 xl:bg-card/95 xl:px-4 xl:pt-4 xl:backdrop-blur">
				<div className="flex flex-wrap items-end justify-between gap-3">
					<div>
					<div className="mw-kicker mb-1">Selected rundown</div>
						<div className="flex items-baseline gap-2">
							<h2 className="text-xl font-semibold text-foreground">{formatDateLabel(date)}</h2>
							<span className="text-xs font-medium text-muted-foreground">{formatWeekday(date)}</span>
						</div>
						<p className="text-xs text-muted-foreground">
							{loading ? t("loading") : t("calendar.resultsSummary", { shown: totalShown, total: timedRows.length + oaRows.length })}
						</p>
					</div>
					<div className="flex items-center gap-2 text-[10px] text-muted-foreground">
						<span className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2.5"><Clock3 size={13} />{t("unified.timedShort")} <strong className="font-mono text-foreground">{timedRows.length}</strong></span>
						<span className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-2.5"><Tv size={13} />{t("unified.oaShort")} <strong className="font-mono text-foreground">{oaRows.length}</strong></span>
					</div>
				</div>

				<div className="relative mt-3">
					<Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
					<input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("calendar.searchPlaceholder")}
						aria-label={t("calendar.searchLabel")}
						className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary"
					/>
					{query && (
						<button type="button" onClick={() => setQuery("")} className="absolute right-1 top-1 inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t("calendar.clearSearch")}>
							<X size={14} />
						</button>
					)}
				</div>
			</div>

			<div className="mw-scrollbar mb-2 flex gap-1.5 overflow-x-auto pb-1">
				<button
					type="button"
					onClick={() => {
						setChannelFilter("all");
						setCategoryFilter("all");
					}}
					aria-pressed={channelFilter === "all"}
					className={`min-h-9 shrink-0 rounded-lg border px-3 text-[11px] font-medium transition-colors ${
						channelFilter === "all"
							? "bg-foreground text-background border-foreground"
							: "bg-card text-foreground border-border hover:bg-muted"
					}`}
				>
					{t("channelFilter.all")}
				</button>
				{ALL_CHANNELS.map(({ slug, name }) => {
					const n = channelCount(slug);
					const active = channelFilter === slug;
					const palette =
						CHANNEL_BADGE[slug as BroadcastChannelSlug] ??
						"bg-muted text-foreground border-border";
					return (
						<button
							key={slug}
							type="button"
							onClick={() => {
								setChannelFilter(slug);
								// Categories are only relevant for qvc/shopch. Reset to
								// "all" when leaving so a stale filter doesn't silently
								// gate OA channels while chips are hidden.
								if (slug !== "qvc" && slug !== "shopch") {
									setCategoryFilter("all");
								}
							}}
							aria-pressed={active}
							className={`min-h-9 shrink-0 rounded-lg border px-3 text-[11px] font-medium transition-colors ${
								active
									? "bg-foreground text-background border-foreground"
									: `${palette} hover:opacity-80`
							}`}
						>
							{name} ({n})
						</button>
					);
				})}
			</div>

			{showCategoryChips && (
				<div className="mw-scrollbar mb-2 flex gap-1.5 overflow-x-auto pb-1">
					<button
						type="button"
						onClick={() => setCategoryFilter("all")}
						aria-pressed={categoryFilter === "all"}
						className={`min-h-9 shrink-0 rounded-lg border px-3 text-[11px] font-medium transition-colors ${
							categoryFilter === "all"
								? "bg-foreground text-background border-foreground"
								: "bg-card text-foreground border-border hover:bg-muted"
						}`}
					>
						{t("categoryFilter.all")}
					</button>
					{visibleCategories.map((c) => (
						<button
							key={c}
							type="button"
							onClick={() => setCategoryFilter(c)}
							aria-pressed={categoryFilter === c}
							className={`min-h-9 shrink-0 rounded-lg border px-3 text-[11px] font-medium transition-colors ${
								categoryFilter === c
									? "bg-foreground text-background border-foreground"
									: "bg-card text-foreground border-border hover:bg-muted"
							}`}
						>
							{c}
						</button>
					))}
				</div>
			)}

			{hasActiveFilters && (
				<div className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-muted/45 px-3 py-2 text-[11px] text-muted-foreground">
					<span>{t("calendar.filteredCount", { count: totalShown })}</span>
					<button type="button" onClick={() => { setChannelFilter("all"); setCategoryFilter("all"); setQuery(""); }} className="font-medium text-primary hover:underline">
						{t("calendar.resetFilters")}
					</button>
				</div>
			)}

			{!loading && hasFetchError && timedRows.length + oaRows.length > 0 && (
				<div className="mb-3 rounded-lg border border-amber-300 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:border-amber-900/50 dark:text-amber-200">
					{t("unified.partialFetchFailed")}
				</div>
			)}

			{totalShown === 0 && !loading ? (
				<div className="text-sm text-muted-foreground p-6 text-center border border-dashed border-border rounded-lg">
					{timedRows.length + oaRows.length === 0
						? hasFetchError
							? t("unified.fetchFailed")
							: t("empty.day")
						: t("empty.filtered")}
				</div>
			) : (
				<div className="flex flex-col gap-4">
					{sortedTimed.length > 0 && (
						<section>
							<div className="text-xs font-medium text-muted-foreground mb-2">
								─ {t("unified.timedSection")} ({sortedTimed.length}件)
								{timedError ? ` · ${t("unified.fetchFailed")}` : ""}
							</div>
							<div className="flex flex-col gap-2">
								{visibleTimed.map((b) => (
									<BroadcastListItem key={b.id} broadcast={b} onPlayVideo={setModalBroadcast} />
								))}
							</div>
							{visibleTimed.length < sortedTimed.length && (
								<ShowMoreButton
									label={t("calendar.showMore", { count: Math.min(LOAD_MORE_ROWS, sortedTimed.length - visibleTimed.length) })}
									onClick={() => setLimits({ key: resultKey, timed: timedLimit + LOAD_MORE_ROWS, oa: oaLimit })}
								/>
							)}
						</section>
					)}
					{filteredOA.length > 0 && (
						<section>
							<div className="text-xs font-medium text-muted-foreground mb-2">
								─ {t("unified.oaSection")} ({filteredOA.length}件)
								{oaError ? ` · ${t("unified.fetchFailed")}` : ""}
							</div>
							<div className="rounded-lg border border-border">
								{[...oaByChannel.entries()]
									.sort(([a], [b]) => a.localeCompare(b))
									.flatMap(([, rows]) =>
										rows.map((r) => <OABroadcastListItem key={r.id} row={r} />),
									)}
							</div>
							{visibleOA.length < filteredOA.length && (
								<ShowMoreButton
									label={t("calendar.showMore", { count: Math.min(LOAD_MORE_ROWS, filteredOA.length - visibleOA.length) })}
									onClick={() => setLimits({ key: resultKey, timed: timedLimit, oa: oaLimit + LOAD_MORE_ROWS })}
								/>
							)}
						</section>
					)}
				</div>
			)}
		</div>
	);
}

function ShowMoreButton({ label, onClick }: { label: string; onClick: () => void }) {
	return (
		<button type="button" onClick={onClick} className="mt-2 inline-flex min-h-10 w-full items-center justify-center rounded-lg border border-dashed border-border bg-muted/25 px-4 text-xs font-medium text-foreground hover:border-primary/40 hover:bg-primary/5">
			{label}
		</button>
	);
}
