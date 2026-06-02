"use client";

import DateCell from "./DateCell";
import { getTodayISOJST } from "@/lib/broadcasts/jst-date";

interface Props {
	year: number;
	month: number;
	countsByDate: Record<string, Record<string, number>>;
	selectedDate: string | null;
	onDateClick: (iso: string) => void;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function buildGrid(year: number, month: number) {
	const first = new Date(Date.UTC(year, month - 1, 1));
	const firstDow = first.getUTCDay();
	const offset = (firstDow + 6) % 7;
	const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

	const cells: { iso: string; day: number; inMonth: boolean }[] = [];

	const prevMonthLast = new Date(Date.UTC(year, month - 1, 0));
	const prevDays = prevMonthLast.getUTCDate();
	const prevYear = month === 1 ? year - 1 : year;
	const prevMonth = month === 1 ? 12 : month - 1;
	for (let i = offset - 1; i >= 0; i--) {
		const d = prevDays - i;
		cells.push({
			iso: `${prevYear}-${pad2(prevMonth)}-${pad2(d)}`,
			day: d,
			inMonth: false,
		});
	}

	for (let d = 1; d <= daysInMonth; d++) {
		cells.push({
			iso: `${year}-${pad2(month)}-${pad2(d)}`,
			day: d,
			inMonth: true,
		});
	}

	const nextYear = month === 12 ? year + 1 : year;
	const nextMonth = month === 12 ? 1 : month + 1;
	let nextDay = 1;
	while (cells.length < 42) {
		cells.push({
			iso: `${nextYear}-${pad2(nextMonth)}-${pad2(nextDay)}`,
			day: nextDay,
			inMonth: false,
		});
		nextDay++;
	}

	return cells;
}

const EMPTY_COUNTS: Record<string, number> = {};

export default function MonthGrid({
	year,
	month,
	countsByDate,
	selectedDate,
	onDateClick,
}: Props) {
	const cells = buildGrid(year, month);
	const todayIso = getTodayISOJST();
	const headers = ["月", "火", "水", "木", "金", "土", "日"];

	return (
		<div>
			<div className="grid grid-cols-7 gap-1 mb-1 text-xs text-muted-foreground">
				{headers.map((h) => (
					<div key={h} className="text-center py-1">
						{h}
					</div>
				))}
			</div>
			<div className="grid grid-cols-7 gap-1">
				{cells.map((c) => (
					<DateCell
						key={c.iso}
						iso={c.iso}
						dayLabel={c.day}
						isCurrentMonth={c.inMonth}
						isToday={c.iso === todayIso}
						isSelected={c.iso === selectedDate}
						channelCounts={countsByDate[c.iso] ?? EMPTY_COUNTS}
						onClick={onDateClick}
					/>
				))}
			</div>
		</div>
	);
}
