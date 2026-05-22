"use client";
import { useMemo } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
	Home,
	Tv,
	CheckCircle2,
	CircleDashed,
	CircleDot,
	Check,
	AlertTriangle,
	XCircle,
	Loader2,
} from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";

export type SessionRow = {
	id: string;
	run_at: string;
	status: "running" | "completed" | "partial" | "failed";
	produced_count: number;
	context: "home_shopping" | "live_commerce";
	feedback_total?: number;
	feedback_count?: number;
};

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

function StatusIcon({ status, size = 11 }: { status: SessionRow["status"]; size?: number }) {
	switch (status) {
		case "completed":
			return <Check size={size} className="text-green-600" aria-label={statusLabel(status)} />;
		case "partial":
			return (
				<AlertTriangle
					size={size}
					className="text-yellow-600"
					aria-label={statusLabel(status)}
				/>
			);
		case "failed":
			return <XCircle size={size} className="text-red-600" aria-label={statusLabel(status)} />;
		default:
			return (
				<Loader2
					size={size}
					className="text-blue-600 animate-spin"
					aria-label={statusLabel(status)}
				/>
			);
	}
}

type FeedbackState = "complete" | "partial" | "none" | "empty";

function feedbackState(s: SessionRow): FeedbackState {
	const total = s.feedback_total ?? 0;
	const done = s.feedback_count ?? 0;
	if (total === 0) return "empty";
	if (done === 0) return "none";
	if (done >= total) return "complete";
	return "partial";
}

function FeedbackIcon({ state, size = 11 }: { state: FeedbackState; size?: number }) {
	switch (state) {
		case "complete":
			return <CheckCircle2 size={size} className="text-emerald-500" />;
		case "partial":
			return <CircleDot size={size} className="text-amber-500" />;
		case "none":
			return <CircleDashed size={size} className="text-muted-foreground" />;
		default:
			return <CircleDashed size={size} className="text-muted-foreground" />;
	}
}

function feedbackTitle(s: SessionRow): string {
	const total = s.feedback_total ?? 0;
	const done = s.feedback_count ?? 0;
	if (total === 0) return "商品なし";
	return `フィードバック ${done}/${total}`;
}

function SessionRowInline({
	s,
	href,
}: {
	s: SessionRow;
	href: string;
}) {
	const isHome = s.context === "home_shopping";
	const fb = feedbackState(s);
	const fbTotal = s.feedback_total ?? 0;
	const fbDone = s.feedback_count ?? 0;

	return (
		<Link
			href={href}
			className="flex items-center gap-1.5 px-1 py-1 rounded hover:bg-muted text-[10px] leading-tight transition-colors"
			title={`${hhmm(s.run_at)} • ${isHome ? "ホーム" : "ライブ"} • ${statusLabel(s.status)} • ${s.produced_count}件 • ${feedbackTitle(s)}`}
		>
			<span className="font-mono text-muted-foreground shrink-0">{hhmm(s.run_at)}</span>
			<span
				className={`inline-flex items-center gap-0.5 px-1 py-px rounded-full font-semibold shrink-0 ${
					isHome
						? "bg-blue-600/10 text-blue-700 border border-blue-200"
						: "bg-purple-600/10 text-purple-700 border border-purple-200"
				}`}
			>
				{isHome ? <Home size={9} /> : <Tv size={9} />}
				<span>{isHome ? "ホーム" : "ライブ"}</span>
			</span>
			<span className="shrink-0" title={statusLabel(s.status)}>
				<StatusIcon status={s.status} size={11} />
			</span>
			<span className="ml-auto flex items-center gap-0.5 text-muted-foreground shrink-0">
				<FeedbackIcon state={fb} size={10} />
				<span className="font-mono">
					{fbDone}/{fbTotal || s.produced_count}
				</span>
			</span>
		</Link>
	);
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
	const today = new Date();
	const isCurrentMonth = today.getFullYear() === year && today.getMonth() === mon;

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
		for (const arr of map.values()) {
			arr.sort((a, b) => new Date(a.run_at).getTime() - new Date(b.run_at).getTime());
		}
		return map;
	}, [sessions, base]);

	const cells: Array<{ day: number | null; sessions: SessionRow[] }> = [];
	for (let i = 0; i < startWeekday; i++) cells.push({ day: null, sessions: [] });
	for (let d = 1; d <= totalDays; d++) {
		cells.push({ day: d, sessions: byDay.get(d) ?? [] });
	}

	const MAX_ROWS = 6;

	return (
		<div className="bg-card border border-border rounded-lg p-4">
			<div className="text-sm font-semibold text-foreground mb-3">
				{year}年 {mon + 1}月
			</div>
			<div className="grid grid-cols-7 gap-1 text-[10px] text-muted-foreground mb-1">
				{["日", "月", "火", "水", "木", "金", "土"].map((d) => (
					<div key={d} className="text-center py-1">{d}</div>
				))}
			</div>
			<div className="grid grid-cols-7 gap-1">
				{cells.map((cell, i) => {
					if (cell.day === null) {
						return (
							<div
								key={i}
								className="min-h-[180px] rounded border border-transparent"
							/>
						);
					}
					const isToday = isCurrentMonth && cell.day === today.getDate();
					const visible = cell.sessions.slice(0, MAX_ROWS);
					const hidden = cell.sessions.length - visible.length;
					return (
						<div
							key={i}
							className={`min-h-[180px] rounded border px-1.5 pt-1 pb-1 flex flex-col ${
								isToday
									? "border-amber-300 bg-amber-600/10"
									: cell.sessions.length > 0
										? "border-border bg-card"
										: "border-border bg-muted/30"
							}`}
						>
							<div className="flex items-center justify-between mb-1">
								<span
									className={`text-[11px] ${
										isToday
											? "font-bold text-amber-700"
											: cell.sessions.length > 0
												? "font-semibold text-foreground"
												: "text-muted-foreground"
									}`}
								>
									{cell.day}
								</span>
								{cell.sessions.length > 0 && (
									<span className="text-[9px] text-muted-foreground font-mono">
										{cell.sessions.length}
									</span>
								)}
							</div>
							<div className="flex flex-col gap-0.5">
								{visible.map((s) => (
									<SessionRowInline
										key={s.id}
										s={s}
										href={localePath(locale, `/analytics/discovery/session/${s.id}`)}
									/>
								))}
								{hidden > 0 && (
									<div className="text-[9px] text-muted-foreground px-1 pt-0.5">
										+{hidden} more
									</div>
								)}
							</div>
						</div>
					);
				})}
			</div>
			<div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[10px] text-muted-foreground">
				<span className="flex items-center gap-1">
					<Home size={10} className="text-blue-600" />
					ホーム
				</span>
				<span className="flex items-center gap-1">
					<Tv size={10} className="text-purple-600" />
					ライブ
				</span>
				<span className="flex items-center gap-1 pl-2 border-l border-border">
					<StatusIcon status="completed" size={11} />完了
				</span>
				<span className="flex items-center gap-1">
					<StatusIcon status="partial" size={11} />部分
				</span>
				<span className="flex items-center gap-1">
					<StatusIcon status="failed" size={11} />失敗
				</span>
				<span className="flex items-center gap-1">
					<StatusIcon status="running" size={11} />実行中
				</span>
				<span className="flex items-center gap-1 pl-2 border-l border-border">
					<FeedbackIcon state="complete" size={11} />FB完了
				</span>
				<span className="flex items-center gap-1">
					<FeedbackIcon state="partial" size={11} />FB部分
				</span>
				<span className="flex items-center gap-1">
					<FeedbackIcon state="none" size={11} />FB未
				</span>
			</div>
		</div>
	);
}
