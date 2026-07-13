"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Loader2, Radio } from "lucide-react";
import UnifiedDayDetailPanel from "./UnifiedDayDetailPanel";
import MonthGrid from "./MonthGrid";
import { getTodayISOJST } from "@/lib/broadcasts/jst-date";
import {
	ALL_CHANNELS,
	CHANNEL_BADGE,
	CHANNEL_SHORT,
} from "@/lib/broadcasts/channel-style";
import { useApiQuery } from "@/lib/client/api-cache";

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
type CalendarView = "month" | "week";

function shiftISODate(iso: string, days: number): string {
	const [y, m, d] = iso.split("-").map(Number);
	const date = new Date(Date.UTC(y, m - 1, d + days));
	return date.toISOString().slice(0, 10);
}

function dateForMonth(year: number, month: number, preferredDay: number): string {
	const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
	return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(preferredDay, lastDay)).padStart(2, "0")}`;
}

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
	const [view, setView] = useState<CalendarView>("month");

	const initialKey = monthKey(initialYear, initialMonth);
	const currentKey = monthKey(year, month);
	const { from, to } = gridBounds(year, month);
	const countsQuery = useApiQuery<{ counts: CountsByDate }>(
		`/api/broadcasts/calendar-counts?from=${from}&to=${to}`,
		currentKey === initialKey ? { fallbackData: { counts: initialCounts } } : undefined,
	);
	const currentMonthCounts = countsQuery.data?.counts ?? EMPTY_COUNTS;
	const loading = countsQuery.isLoading;
	const error = countsQuery.error?.message ?? null;

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

	const navigate = useCallback((direction: -1 | 1) => {
		if (view === "week") {
			const anchor = selectedDate ?? dateForMonth(year, month, 1);
			handleDateClick(shiftISODate(anchor, direction * 7));
			return;
		}

		const nextMonthIndex = year * 12 + (month - 1) + direction;
		const nextYear = Math.floor(nextMonthIndex / 12);
		const nextMonth = (nextMonthIndex % 12 + 12) % 12 + 1;
		const preferredDay = selectedDate ? Number(selectedDate.slice(8, 10)) : 1;
		handleDateClick(dateForMonth(nextYear, nextMonth, preferredDay));
	}, [handleDateClick, month, selectedDate, view, year]);

	const goToday = useCallback(() => handleDateClick(getTodayISOJST()), [handleDateClick]);

	const handleMonthJump = useCallback((value: string) => {
		if (!/^\d{4}-\d{2}$/.test(value)) return;
		const [nextYear, nextMonth] = value.split("-").map(Number);
		const preferredDay = selectedDate ? Number(selectedDate.slice(8, 10)) : 1;
		handleDateClick(dateForMonth(nextYear, nextMonth, preferredDay));
	}, [handleDateClick, selectedDate]);

	const monthLabel = `${year}年 ${month}月`;
	const monthSummary = useMemo(() => {
		const entries = Object.entries(currentMonthCounts).filter(([iso]) => iso.startsWith(`${currentKey}-`));
		const totals = entries.map(([iso, channels]) => ({
			iso,
			total: Object.values(channels).reduce((sum, count) => sum + count, 0),
		}));
		const busiest = totals.reduce<{ iso: string; total: number } | null>(
			(best, item) => !best || item.total > best.total ? item : best,
			null,
		);
		return {
			activeDays: totals.filter((item) => item.total > 0).length,
			total: totals.reduce((sum, item) => sum + item.total, 0),
			busiest,
		};
	}, [currentKey, currentMonthCounts]);

	return (
		<div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(470px,0.9fr)_minmax(0,1.1fr)]">
			<section className="mw-panel min-w-0 p-3 sm:p-4">
				<div className="mb-3 flex flex-wrap items-start justify-between gap-3">
					<div>
						<div className="mw-kicker mb-1 inline-flex items-center gap-1.5"><Radio size={12} /> Calendar signal</div>
						<h2 className="text-lg font-semibold text-foreground">{monthLabel}</h2>
						<p className="text-[11px] text-muted-foreground">{t("calendar.subtitle")}</p>
					</div>
					<div className="inline-flex rounded-lg border border-border bg-muted/70 p-0.5" aria-label={t("calendar.viewLabel")}>
						{(["month", "week"] as const).map((mode) => (
							<button
								key={mode}
								type="button"
								onClick={() => setView(mode)}
								aria-pressed={view === mode}
								className={`min-h-8 rounded-md px-3 text-xs font-medium transition-colors ${view === mode ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
							>
								{t(`calendar.views.${mode}`)}
							</button>
						))}
					</div>
				</div>

				<div className="mb-3 flex items-center gap-2 rounded-xl border border-border bg-muted/35 p-1.5">
					<button
						type="button"
						onClick={() => navigate(-1)}
						className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-card hover:text-foreground"
						aria-label={view === "month" ? t("monthNav.prev") : t("weekNav.prev")}
					>
						<ChevronLeft size={18} />
					</button>
					<button type="button" onClick={goToday} className="min-h-9 shrink-0 rounded-lg border border-border bg-card px-3 text-xs font-semibold text-foreground hover:border-primary/50">
						{t("calendar.today")}
					</button>
					<label className="relative min-w-0 flex-1">
						<span className="sr-only">{t("calendar.jumpToMonth")}</span>
						<CalendarDays size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
						<input
							type="month"
							value={`${year}-${String(month).padStart(2, "0")}`}
							onChange={(event) => handleMonthJump(event.target.value)}
							className="h-9 w-full min-w-0 rounded-lg border border-border bg-card pl-8 pr-2 text-xs font-medium text-foreground"
						/>
					</label>
					<button
						type="button"
						onClick={() => navigate(1)}
						className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-card hover:text-foreground"
						aria-label={view === "month" ? t("monthNav.next") : t("weekNav.next")}
					>
						<ChevronRight size={18} />
					</button>
				</div>

				<div className="mb-3 grid grid-cols-3 divide-x divide-border rounded-xl border border-border bg-card">
					<CalendarMetric label={t("calendar.metrics.slots")} value={monthSummary.total.toLocaleString()} />
					<CalendarMetric label={t("calendar.metrics.activeDays")} value={t("calendar.dayCount", { count: monthSummary.activeDays })} />
					<CalendarMetric label={t("calendar.metrics.peak")} value={monthSummary.busiest ? t("calendar.peakValue", { day: Number(monthSummary.busiest.iso.slice(8)), count: monthSummary.busiest.total }) : "—"} />
				</div>
				{loading && (
					<div className="inline-flex items-center gap-1.5 text-sm text-foreground/80 mb-2">
						<Loader2 size={14} className="animate-spin" />
						{t("loading")}
					</div>
				)}
				{error && (
					<div className="text-xs text-red-600 dark:text-red-400 mb-2">
						{t("empty.apiError")} ({error})
					</div>
				)}
				<MonthGrid
					year={year}
					month={month}
					view={view}
					countsByDate={currentMonthCounts}
					selectedDate={selectedDate}
					onDateClick={handleDateClick}
				/>
				<CalendarLegend label={t("calendar.legend")} />
			</section>

			<aside className="mw-panel mw-scrollbar min-w-0 min-h-[32rem] p-3 sm:p-4 xl:sticky xl:top-5 xl:max-h-[calc(100vh-2.5rem)] xl:overflow-y-auto">
				<UnifiedDayDetailPanel date={selectedDate} />
			</aside>
		</div>
	);
}

function CalendarMetric({ label, value }: { label: string; value: string }) {
	return (
		<div className="min-w-0 px-2 py-2.5 text-center">
			<div className="truncate font-mono text-sm font-semibold tabular-nums text-foreground">{value}</div>
			<div className="mt-0.5 truncate text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
		</div>
	);
}

function CalendarLegend({ label }: { label: string }) {
	return (
		<details className="group mt-3 border-t border-border pt-3 text-[10px] text-muted-foreground">
			<summary className="flex min-h-8 cursor-pointer list-none items-center justify-between rounded-md px-1 font-medium text-foreground hover:bg-muted">
				<span>{label}</span>
				<ChevronRight size={13} className="transition-transform group-open:rotate-90" />
			</summary>
			<div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
				{ALL_CHANNELS.map(({ slug, name }) => (
					<span key={slug} className="inline-flex items-center gap-1">
						<span className={`inline-flex size-4 items-center justify-center rounded-[3px] border text-[9px] font-semibold ${CHANNEL_BADGE[slug]}`}>
							{CHANNEL_SHORT[slug]}
						</span>
						{name}
					</span>
				))}
			</div>
		</details>
	);
}
