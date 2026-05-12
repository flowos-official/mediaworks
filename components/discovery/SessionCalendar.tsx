"use client";
import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Popover } from "@base-ui/react/popover";
import { Home, Tv } from "lucide-react";

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

function hhmm(iso: string): string {
	return new Date(iso).toLocaleTimeString("ja-JP", {
		hour: "2-digit",
		minute: "2-digit",
	});
}

function statusLabel(status: SessionRow["status"]): string {
	switch (status) {
		case "completed":
			return "完了";
		case "partial":
			return "部分";
		case "failed":
			return "失敗";
		default:
			return "実行中";
	}
}

function statusBadgeClasses(status: SessionRow["status"]): string {
	switch (status) {
		case "completed":
			return "bg-green-100 text-green-700";
		case "partial":
			return "bg-yellow-100 text-yellow-700";
		case "failed":
			return "bg-red-100 text-red-700";
		default:
			return "bg-blue-100 text-blue-700";
	}
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
					return (
						<Popover.Root key={i}>
							<Popover.Trigger
								className="aspect-square flex flex-col items-center justify-start pt-1 rounded hover:bg-gray-50 transition-colors w-full"
								aria-label={`${mon + 1}月${cell.day}日 — ${cell.sessions.length} sessions`}
							>
								<span className="text-[10px] text-gray-700">{cell.day}</span>
								<div className="flex gap-0.5 mt-0.5 items-center">
									{cell.sessions.slice(0, 4).map((s) => (
										<span
											key={s.id}
											className={`w-1.5 h-1.5 rounded-full ${statusColor(s.status)} ${s.context === "live_commerce" ? "ring-1 ring-purple-400" : ""}`}
										/>
									))}
									{cell.sessions.length > 4 && (
										<span className="text-[9px] text-gray-500 ml-0.5">
											+{cell.sessions.length - 4}
										</span>
									)}
								</div>
							</Popover.Trigger>
							<Popover.Portal>
								<Popover.Positioner sideOffset={6} align="start">
									<Popover.Popup className="bg-white border border-gray-200 rounded-lg shadow-lg w-56 overflow-hidden">
										<div className="px-3 py-2 text-[11px] font-semibold text-gray-700 border-b border-gray-100 bg-gray-50">
											{year}年{mon + 1}月{cell.day}日 ({cell.sessions.length})
										</div>
										<ul className="divide-y divide-gray-100 max-h-72 overflow-auto">
											{cell.sessions.map((s) => {
												const isHome = s.context === "home_shopping";
												return (
													<li key={s.id}>
														<Link
															href={`/${locale}/analytics/discovery/session/${s.id}`}
															className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-gray-50"
														>
															<span className="font-mono text-[11px] text-gray-500 w-10 shrink-0">
																{hhmm(s.run_at)}
															</span>
															<span
																className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
																	isHome
																		? "bg-blue-50 text-blue-700 border border-blue-200"
																		: "bg-purple-50 text-purple-700 border border-purple-200"
																}`}
															>
																{isHome ? <Home size={9} /> : <Tv size={9} />}
																{isHome ? "ホーム" : "ライブ"}
															</span>
															<span className={`text-[10px] px-1.5 py-0.5 rounded-full ${statusBadgeClasses(s.status)}`}>
																{statusLabel(s.status)}
															</span>
															<span className="ml-auto text-[11px] text-gray-600 shrink-0">
																{s.produced_count}件
															</span>
														</Link>
													</li>
												);
											})}
										</ul>
									</Popover.Popup>
								</Popover.Positioner>
							</Popover.Portal>
						</Popover.Root>
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
