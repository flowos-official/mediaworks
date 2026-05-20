"use client";
import Link from "next/link";
import { FileText, Loader2, CheckCircle, AlertCircle, Clock, ArrowRight } from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";

interface Row {
	id: string;
	title: string;
	status: "pending" | "generating" | "ready" | "failed";
	updated_at: string;
}

const STATUS_CONFIG: Record<Row["status"], { icon: typeof Clock; cls: string; label: string }> = {
	pending: { icon: Clock, cls: "bg-yellow-50 text-yellow-700 border-yellow-200/80", label: "待機中" },
	generating: { icon: Loader2, cls: "bg-blue-50 text-blue-700 border-blue-200/80", label: "生成中" },
	ready: { icon: CheckCircle, cls: "bg-emerald-50 text-emerald-700 border-emerald-200/80", label: "完成" },
	failed: { icon: AlertCircle, cls: "bg-red-50 text-red-700 border-red-200/80", label: "失敗" },
};

function formatStamp(iso: string): string {
	const d = new Date(iso);
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relativeFromNow(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	const min = Math.floor(ms / 60_000);
	if (min < 1) return "たった今";
	if (min < 60) return `${min}分前`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}時間前`;
	const day = Math.floor(hr / 24);
	if (day < 7) return `${day}日前`;
	return formatStamp(iso);
}

export function ScreenplayList({ rows, locale }: { rows: Row[]; locale: string }) {
	if (rows.length === 0) {
		return (
			<div className="rounded-2xl border border-gray-200 bg-white shadow-sm">
				<div className="py-16 flex flex-col items-center justify-center text-center px-6">
					<div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mb-4 ring-1 ring-blue-100">
						<FileText size={26} className="text-blue-600" />
					</div>
					<p className="text-gray-900 font-medium">まだ台本がありません</p>
					<p className="text-sm text-gray-500 mt-1 max-w-sm">
						「新しい台本を作成」から、商品資料をアップロードするか URL を指定して生成を開始してください。
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
			{/* Header strip */}
			<div className="hidden md:grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center px-5 py-3 border-b border-gray-100 bg-gray-50/60">
				<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-gray-500">タイトル</div>
				<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-gray-500 w-24 text-center">状態</div>
				<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-gray-500 w-36 text-right">最終更新</div>
				<div className="w-5" aria-hidden />
			</div>

			<ul className="divide-y divide-gray-100">
				{rows.map((r) => {
					const cfg = STATUS_CONFIG[r.status];
					const Icon = cfg.icon;
					return (
						<li key={r.id}>
							<Link
								href={localePath(locale, `/screenplays/${r.id}`)}
								className="group grid grid-cols-[1fr_auto_auto_auto] md:grid-cols-[1fr_auto_auto_auto] gap-4 items-center px-5 py-3.5 hover:bg-blue-50/30 transition-colors"
							>
								<div className="min-w-0 flex items-center gap-3">
									<div className="w-9 h-9 rounded-lg bg-blue-50 ring-1 ring-blue-100 flex items-center justify-center shrink-0">
										<FileText size={16} className="text-blue-600" />
									</div>
									<div className="min-w-0">
										<div className="text-sm font-medium text-gray-900 truncate">
											{r.title || <span className="text-gray-400 italic">（無題）</span>}
										</div>
										<div className="text-[11px] text-gray-400 mt-0.5 font-mono truncate md:hidden">
											{relativeFromNow(r.updated_at)}
										</div>
									</div>
								</div>

								<span
									className={`hidden md:inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${cfg.cls} w-24 justify-center`}
								>
									<Icon size={11} className={r.status === "generating" ? "animate-spin" : ""} />
									{cfg.label}
								</span>

								<span className="hidden md:block text-xs text-gray-500 tabular-nums w-36 text-right">
									<span className="text-gray-400">{relativeFromNow(r.updated_at)}</span>
								</span>

								<ArrowRight
									size={14}
									className="text-gray-300 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all shrink-0"
								/>
							</Link>
						</li>
					);
				})}
			</ul>

			<div className="px-5 py-2.5 border-t border-gray-100 bg-gray-50/40 text-[11px] text-gray-500 tabular-nums">
				{rows.length} 件
			</div>
		</div>
	);
}
