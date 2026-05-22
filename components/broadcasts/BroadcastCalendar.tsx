"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import UnifiedDayDetailPanel from "./UnifiedDayDetailPanel";
import MonthGrid from "./MonthGrid";
import {
	ALL_CHANNELS,
	CHANNEL_BADGE,
	CHANNEL_SHORT,
} from "@/lib/broadcasts/channel-style";

type CountsByDate = Record<string, Record<string, number>>;

interface Props {
	initialYear: number;
	initialMonth: number;
	initialDate: string | null;
	initialCounts: CountsByDate;
}

function monthKey(y: number, m: number) {
	return `${y}-${String(m).padStart(2, "0")}`;
}

function gridBounds(y: number, m: number): { from: string; to: string } {
	const prevY = m === 1 ? y - 1 : y;
	const prevM = m === 1 ? 12 : m - 1;
	const nextY = m === 12 ? y + 1 : y;
	const nextM = m === 12 ? 1 : m + 1;
	const prevLast = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
	const nextLast = new Date(Date.UTC(nextY, nextM, 0)).getUTCDate();
	return {
		from: `${prevY}-${String(prevM).padStart(2, "0")}-${String(Math.max(prevLast - 6, 1)).padStart(2, "0")}`,
		to: `${nextY}-${String(nextM).padStart(2, "0")}-${String(Math.min(nextLast, 7)).padStart(2, "0")}`,
	};
}

const EMPTY_COUNTS: CountsByDate = {};

export default function BroadcastCalendar({
	initialYear,
	initialMonth,
	initialDate,
	initialCounts,
}: Props) {
	const t = useTranslations("broadcasts");
	const router = useRouter();

	const [year, setYear] = useState(initialYear);
	const [month, setMonth] = useState(initialMonth);
	const [selectedDate, setSelectedDate] = useState<string | null>(initialDate);

	const initialKey = monthKey(initialYear, initialMonth);
	const [cache, setCache] = useState<Map<string, CountsByDate>>(
		() => new Map([[initialKey, initialCounts]]),
	);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const currentKey = monthKey(year, month);
	const currentMonthCounts = useMemo(
		() => cache.get(currentKey) ?? EMPTY_COUNTS,
		[cache, currentKey],
	);

	useEffect(() => {
		if (cache.has(currentKey)) return;
		const { from, to } = gridBounds(year, month);
		const controller = new AbortController();
		void (async () => {
			setLoading(true);
			setError(null);
			try {
				const r = await fetch(
					`/api/broadcasts/calendar-counts?from=${from}&to=${to}`,
					{ signal: controller.signal },
				);
				if (!r.ok) throw new Error(r.statusText);
				const json = (await r.json()) as { counts: CountsByDate };
				setCache((prev) => new Map(prev).set(currentKey, json.counts ?? {}));
			} catch (e) {
				if ((e as { name?: string }).name !== "AbortError") {
					setError(String(e));
				}
			} finally {
				setLoading(false);
			}
		})();
		return () => controller.abort();
	}, [currentKey, year, month, cache]);

	// URL only carries the selected date now. Channel/category state moved
	// into UnifiedDayDetailPanel and is no longer shared with the page URL.
	const syncUrl = useCallback(
		(date: string | null) => {
			const params = new URLSearchParams();
			if (date) params.set("date", date);
			const qs = params.toString();
			router.replace(qs ? `?${qs}` : "?", { scroll: false });
		},
		[router],
	);

	const handleDateClick = useCallback(
		(iso: string) => {
			setSelectedDate(iso);
			const [y, m] = iso.split("-").map((x) => parseInt(x, 10));
			if (y !== year || m !== month) {
				setYear(y);
				setMonth(m);
			}
			syncUrl(iso);
		},
		[year, month, syncUrl],
	);

	// Month nav stays purely client-side — useEffect above auto-fetches the
	// new month's counts via `/api/broadcasts/calendar-counts` when it's
	// missing from cache.
	const goPrev = useCallback(() => {
		if (month === 1) {
			setYear(year - 1);
			setMonth(12);
		} else {
			setMonth(month - 1);
		}
		setSelectedDate(null);
	}, [year, month]);

	const goNext = useCallback(() => {
		if (month === 12) {
			setYear(year + 1);
			setMonth(1);
		} else {
			setMonth(month + 1);
		}
		setSelectedDate(null);
	}, [year, month]);

	const monthLabel = `${year}年 ${month}月`;

	return (
		<div className="grid md:grid-cols-2 gap-6">
			<div>
				<div className="flex items-center justify-between mb-3">
					<button
						type="button"
						onClick={goPrev}
						className="p-1.5 rounded hover:bg-muted"
						aria-label={t("monthNav.prev")}
					>
						<ChevronLeft size={18} />
					</button>
					<h2 className="text-lg font-semibold text-foreground">{monthLabel}</h2>
					<button
						type="button"
						onClick={goNext}
						className="p-1.5 rounded hover:bg-muted"
						aria-label={t("monthNav.next")}
					>
						<ChevronRight size={18} />
					</button>
				</div>
				{loading && (
					<div className="text-xs text-muted-foreground mb-2">Loading…</div>
				)}
				{error && (
					<div className="text-xs text-red-600 dark:text-red-400 mb-2">
						{t("empty.apiError")} ({error})
					</div>
				)}
				<MonthGrid
					year={year}
					month={month}
					countsByDate={currentMonthCounts}
					selectedDate={selectedDate}
					onDateClick={handleDateClick}
				/>
				<CalendarLegend />
			</div>

			<div className="md:max-h-[calc(100vh-12rem)] md:overflow-y-auto md:sticky md:top-4 pr-1">
				<UnifiedDayDetailPanel date={selectedDate} />
			</div>
		</div>
	);
}

function CalendarLegend() {
	return (
		<div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
			{ALL_CHANNELS.map(({ slug, name }) => (
				<span key={slug} className="inline-flex items-center gap-1">
					<span
						className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-[3px] text-[9px] font-semibold border ${CHANNEL_BADGE[slug]}`}
					>
						{CHANNEL_SHORT[slug]}
					</span>
					{name}
				</span>
			))}
		</div>
	);
}
