"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
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

const CATEGORIES_BY_CHANNEL: Record<"qvc" | "shopch", readonly string[]> = {
	qvc: [
		// Must match QVC's actual top-level breadcrumb labels. qvc.jp's product
		// pages only ever surface these 6+ rooted categories — homepage nav
		// labels like "ホーム" / "キッチングッズ" / "ファッション小物" are
		// marketing groupings and never appear in actual breadcrumbs (subsumed
		// into "ホーム・キッチン" and "ファッション" respectively). See
		// scripts/survey-qvc-categories.ts for the live survey.
		"ビューティ",
		"ファッション",
		"健康・ダイエット",
		"ホーム・キッチン",
		"レジャー・ホビー",
		"家電",
	],
	shopch: [
		// Sourced directly from shopch.jp's /json/programprodlist2/{id}.json
		// `pgmcategory` field as of 2026-05-19 (was Gemini-classified before;
		// switched after empirical analysis showed 24% Gemini disagreement
		// and 33% NULL rate). All 10 display names the site emits are
		// included so the operator can toggle visibility in the chip filter.
		"コスメ",
		"グルメ・お酒",
		"美容・ダイエット・フィットネス",
		"靴・バッグ・小物・インナー",
		"ファッション",
		"ミックス",
		"ホーム・インテリア",
		"家電",
		"ジュエリー",
		"旅・趣味・暮らし・コレクターズ",
	],
};

const QVC_WHITELIST = new Set<string>(CATEGORIES_BY_CHANNEL.qvc);
const SHOPCH_WHITELIST = new Set<string>(CATEGORIES_BY_CHANNEL.shopch);

// Whitelist gate applied at display time. Data is still persisted regardless
// of category — see CLAUDE.md "Broadcast Calendar" policy. Non-whitelisted
// QVC/ShopCh slots are hidden even when `categoryFilter === "all"`. Other
// (OA) channels have no whitelist and pass through unchanged.
function isWhitelistedSlot(channel: string, category: string | null): boolean {
	if (channel === "qvc") return !!category && QVC_WHITELIST.has(category);
	if (channel === "shopch") return !!category && SHOPCH_WHITELIST.has(category);
	return true;
}

interface Props {
	date: string | null;
}

type DayLoadState = {
	date: string | null;
	timedRows: Broadcast[];
	oaRows: OARow[];
	timedError: boolean;
	oaError: boolean;
};

function formatDateLabel(iso: string): string {
	const [y, m, d] = iso.split("-");
	return `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

export default function UnifiedDayDetailPanel({ date }: Props) {
	const t = useTranslations("broadcasts");
	const [channelFilter, setChannelFilter] = useState<string>("all");
	const [categoryFilter, setCategoryFilter] = useState<string>("all");
	const [dayState, setDayState] = useState<DayLoadState>({
		date: null,
		timedRows: [],
		oaRows: [],
		timedError: false,
		oaError: false,
	});
	const [modalBroadcast, setModalBroadcast] = useState<Broadcast | null>(null);

	useEffect(() => {
		if (!date) return;
		const ctrl = new AbortController();
		const loadDay = async () => {
			const [bRes, hRes] = await Promise.allSettled([
				fetch(`/api/broadcasts?from=${date}&to=${date}`, {
					signal: ctrl.signal,
				}),
				fetch(`/api/historical-broadcasts?date=${date}&limit=500`, {
					signal: ctrl.signal,
				}),
			]);

			if (ctrl.signal.aborted) return;

			let timedRows: Broadcast[] = [];
			let oaRows: OARow[] = [];
			let timedError = false;
			let oaError = false;

			if (bRes.status === "fulfilled" && bRes.value.ok) {
				try {
					const json = (await bRes.value.json()) as { broadcasts: Broadcast[] };
					timedRows = json.broadcasts ?? [];
				} catch {
					timedError = true;
				}
			} else {
				timedError = true;
			}

			if (hRes.status === "fulfilled" && hRes.value.ok) {
				try {
					const json = (await hRes.value.json()) as { rows: OARow[] };
					oaRows = json.rows ?? [];
				} catch {
					oaError = true;
				}
			} else {
				oaError = true;
			}

			if (!ctrl.signal.aborted) {
				setDayState({ date, timedRows, oaRows, timedError, oaError });
			}
		};
		void loadDay();
		return () => ctrl.abort();
	}, [date]);

	const isCurrentDay = date !== null && dayState.date === date;
	const timedRows = isCurrentDay ? dayState.timedRows : [];
	const oaRows = isCurrentDay ? dayState.oaRows : [];
	const timedError = isCurrentDay ? dayState.timedError : false;
	const oaError = isCurrentDay ? dayState.oaError : false;
	const loading = date !== null && !isCurrentDay;

	if (!date) {
		return (
			<div className="text-sm text-muted-foreground p-6 text-center">
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
	const filteredTimed = timedRows.filter((b) =>
		matchesFilters(b.channel, b.category ?? null),
	);
	const filteredOA = oaRows.filter((r) =>
		matchesFilters(r.channel, r.category),
	);
	const totalShown = filteredTimed.length + filteredOA.length;

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

	const oaByChannel = new Map<string, OARow[]>();
	for (const row of filteredOA) {
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
			<div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
				<div>
					<h2 className="text-xl font-semibold text-foreground">
						{formatDateLabel(date)}
					</h2>
					<p className="text-xs text-muted-foreground">
						{loading ? t("loading") : t("broadcastCount", { count: totalShown })}
					</p>
				</div>
			</div>

			<div className="flex flex-wrap gap-1.5 mb-3">
				<button
					type="button"
					onClick={() => {
						setChannelFilter("all");
						setCategoryFilter("all");
					}}
					className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
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
							className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
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
				<div className="flex flex-wrap gap-1.5 mb-3">
					<button
						type="button"
						onClick={() => setCategoryFilter("all")}
						className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
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
							className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
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

			{totalShown === 0 && !loading ? (
				<div className="text-sm text-muted-foreground p-6 text-center border border-dashed border-border rounded-lg">
					{timedRows.length + oaRows.length === 0
						? t("empty.day")
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
								{sortedTimed.map((b) => (
									<BroadcastListItem key={b.id} broadcast={b} onPlayVideo={setModalBroadcast} />
								))}
							</div>
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
						</section>
					)}
				</div>
			)}
		</div>
	);
}
