"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import BroadcastListItem, {
	type Broadcast,
} from "./BroadcastListItem";
import OABroadcastListItem, { type OARow } from "./OABroadcastListItem";
import {
	ALL_CHANNELS,
	CHANNEL_BADGE,
	isOAChannel,
	type BroadcastChannelSlug,
} from "@/lib/broadcasts/channel-style";

const CATEGORIES_BY_CHANNEL: Record<"qvc" | "shopch", readonly string[]> = {
	qvc: [
		"ビューティー",
		"ファッション小物",
		"健康・ダイエット",
		"ホーム",
		"キッチングッズ",
		"レジャー・ホビー",
		"家電",
	],
	shopch: [
		"靴・バッグ・小物・インナー",
		"コスメ",
		"美容・ダイエット・フィットネス",
		"ホーム・インテリア",
		"家電",
	],
};

interface Props {
	date: string | null;
}

function formatDateLabel(iso: string): string {
	const [y, m, d] = iso.split("-");
	return `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

export default function UnifiedDayDetailPanel({ date }: Props) {
	const t = useTranslations("broadcasts");
	const [channelFilter, setChannelFilter] = useState<string>("all");
	const [categoryFilter, setCategoryFilter] = useState<string>("all");
	const [timedRows, setTimedRows] = useState<Broadcast[]>([]);
	const [oaRows, setOaRows] = useState<OARow[]>([]);
	const [loading, setLoading] = useState(false);
	const [timedError, setTimedError] = useState(false);
	const [oaError, setOaError] = useState(false);

	const fetchDay = useCallback(async (iso: string, signal: AbortSignal) => {
		setLoading(true);
		setTimedError(false);
		setOaError(false);
		const [bRes, hRes] = await Promise.allSettled([
			fetch(`/api/broadcasts?from=${iso}&to=${iso}`, { signal }),
			fetch(`/api/historical-broadcasts?date=${iso}&limit=500`, { signal }),
		]);

		if (bRes.status === "fulfilled" && bRes.value.ok) {
			const json = (await bRes.value.json()) as { broadcasts: Broadcast[] };
			setTimedRows(json.broadcasts ?? []);
		} else {
			setTimedRows([]);
			const isAbort =
				bRes.status === "rejected" && bRes.reason instanceof DOMException;
			if (!isAbort) setTimedError(true);
		}

		if (hRes.status === "fulfilled" && hRes.value.ok) {
			const json = (await hRes.value.json()) as { rows: OARow[] };
			setOaRows(json.rows ?? []);
		} else {
			setOaRows([]);
			const isAbort =
				hRes.status === "rejected" && hRes.reason instanceof DOMException;
			if (!isAbort) setOaError(true);
		}
		setLoading(false);
	}, []);

	useEffect(() => {
		if (!date) return;
		const ctrl = new AbortController();
		void fetchDay(date, ctrl.signal);
		return () => ctrl.abort();
	}, [date, fetchDay]);

	if (!date) {
		return (
			<div className="text-sm text-gray-500 p-6 text-center">
				{t("empty.day")}
			</div>
		);
	}

	const matchesFilters = (channel: string, category: string | null): boolean => {
		if (channelFilter !== "all" && channel !== channelFilter) return false;
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
				(categoryFilter === "all" || b.category === categoryFilter),
		).length;
		const fromOA = oaRows.filter(
			(r) =>
				r.channel === slug &&
				(categoryFilter === "all" || r.category === categoryFilter),
		).length;
		return fromTimed + fromOA;
	};

	const showCategoryChips =
		channelFilter === "all" ||
		channelFilter === "qvc" ||
		channelFilter === "shopch";
	const visibleCategories: readonly string[] = !showCategoryChips
		? []
		: channelFilter === "all"
			? Array.from(
					new Set([
						...CATEGORIES_BY_CHANNEL.qvc,
						...CATEGORIES_BY_CHANNEL.shopch,
					]),
				)
			: CATEGORIES_BY_CHANNEL[channelFilter as "qvc" | "shopch"];

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
			<div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
				<div>
					<h2 className="text-xl font-semibold text-gray-900">
						{formatDateLabel(date)}
					</h2>
					<p className="text-xs text-gray-500">
						{loading ? t("loading") : t("broadcastCount", { count: totalShown })}
					</p>
				</div>
			</div>

			<div className="flex flex-wrap gap-1.5 mb-3">
				<button
					type="button"
					onClick={() => setChannelFilter("all")}
					className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
						channelFilter === "all"
							? "bg-gray-900 text-white border-gray-900"
							: "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
					}`}
				>
					{t("channelFilter.all")}
				</button>
				{ALL_CHANNELS.map(({ slug, name }) => {
					const n = channelCount(slug);
					const active = channelFilter === slug;
					const palette =
						CHANNEL_BADGE[slug as BroadcastChannelSlug] ??
						"bg-gray-100 text-gray-700 border-gray-200";
					return (
						<button
							key={slug}
							type="button"
							onClick={() => {
								setChannelFilter(slug);
								if (isOAChannel(slug) && categoryFilter !== "all") {
									setCategoryFilter("all");
								}
							}}
							className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
								active
									? "bg-gray-900 text-white border-gray-900"
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
								? "bg-gray-900 text-white border-gray-900"
								: "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
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
									? "bg-gray-900 text-white border-gray-900"
									: "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
							}`}
						>
							{c}
						</button>
					))}
				</div>
			)}

			{totalShown === 0 && !loading ? (
				<div className="text-sm text-gray-500 p-6 text-center border border-dashed border-gray-200 rounded-lg">
					{timedRows.length + oaRows.length === 0
						? t("empty.day")
						: t("empty.filtered")}
				</div>
			) : (
				<div className="flex flex-col gap-4">
					{sortedTimed.length > 0 && (
						<section>
							<div className="text-xs font-medium text-gray-500 mb-2">
								─ {t("unified.timedSection")} ({sortedTimed.length}件)
								{timedError ? ` · ${t("unified.fetchFailed")}` : ""}
							</div>
							<div className="flex flex-col gap-2">
								{sortedTimed.map((b) => (
									<BroadcastListItem key={b.id} broadcast={b} />
								))}
							</div>
						</section>
					)}
					{filteredOA.length > 0 && (
						<section>
							<div className="text-xs font-medium text-gray-500 mb-2">
								─ {t("unified.oaSection")} ({filteredOA.length}件)
								{oaError ? ` · ${t("unified.fetchFailed")}` : ""}
							</div>
							<div className="rounded-lg border border-gray-200">
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
