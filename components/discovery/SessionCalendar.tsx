"use client";
import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

export type SessionRow = {
	id: string;
	run_at: string;
	status: "running" | "completed" | "partial" | "failed";
	produced_count: number;
	context: "home_shopping" | "live_commerce";
};

function statusColor(status: SessionRow["status"]): string {
	switch (status) {
		case "completed":
			return "bg-green-500";
		case "partial":
			return "bg-yellow-500";
		case "failed":
			return "bg-red-500";
		default:
			return "bg-blue-500";
	}
}

function monthKey(d: Date): string {
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function SessionCalendar({ sessions, month }: { sessions: SessionRow[]; month?: Date }) {
	const { locale } = useParams<{ locale: string }>();
	const base = month ?? new Date();
	const year = base.getFullYear();
	const mon = base.getMonth();
	const firstDay = new Date(year, mon, 1);
	const lastDay = new Date(year, mon + 1, 0);
	const totalDays = lastDay.getDate();
	const startWeekday = firstDay.getDay();

	const byDay = useMemo(() => {
		const map = new Map<number, SessionRow[]>();
		for (const s of sessions) {
			const d = new Date(s.run_at);
			if (monthKey(d) !== monthKey(base)) continue;
			const day = d.getDate();
			const arr = map.get(day) ?? [];
			arr.push(s);
			map.set(day, arr);
		}
		return map;
	}, [sessions, base]);

	const cells: Array<{ day: number | null; sessions: SessionRow[] }> = [];
	for (let i = 0; i < startWeekday; i++) cells.push({ day: null, sessions: [] });
	for (let d = 1; d <= totalDays; d++) {
		cells.push({ day: d, sessions: byDay.get(d) ?? [] });
	}

	return (
		<div className="bg-white border border-gray-200 rounded-lg p-4">
			<div className="text-sm font-semibold text-gray-800 mb-3">
				{year}年 {mon + 1}月
			</div>
			<div className="grid grid-cols-7 gap-1 text-[10px] text-gray-400 mb-1">
				{["日", "月", "火", "水", "木", "金", "土"].map((d) => (
					<div key={d} className="text-center py-1">{d}</div>
				))}
			</div>
			<div className="grid grid-cols-7 gap-1">
				{cells.map((cell, i) => {
					if (cell.day === null) return <div key={i} />;
					if (cell.sessions.length === 0) {
						return (
							<div key={i} className="aspect-square flex flex-col items-center justify-start pt-1 text-[10px] text-gray-300">
								{cell.day}
							</div>
						);
					}
					const first = cell.sessions[0];
					const href = `/${locale}/analytics/discovery/session/${first.id}`;
					return (
						<Link
							key={i}
							href={href}
							className="aspect-square flex flex-col items-center justify-start pt-1 rounded hover:bg-gray-50 transition-colors"
							title={cell.sessions.map((s) => `${s.context === "home_shopping" ? "ホーム" : "ライブ"}: ${s.status} (${s.produced_count})`).join("\n")}
						>
							<span className="text-[10px] text-gray-700">{cell.day}</span>
							<div className="flex gap-0.5 mt-0.5">
								{cell.sessions.slice(0, 4).map((s) => (
									<span
										key={s.id}
										className={`w-1.5 h-1.5 rounded-full ${statusColor(s.status)} ${s.context === "live_commerce" ? "ring-1 ring-purple-400" : ""}`}
									/>
								))}
							</div>
						</Link>
					);
				})}
			</div>
			<div className="flex flex-wrap gap-3 mt-3 text-[10px] text-gray-500">
				<span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" />完了</span>
				<span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500" />部分</span>
				<span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" />失敗</span>
				<span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-gray-300 ring-1 ring-purple-400" />ライブ</span>
			</div>
		</div>
	);
}
