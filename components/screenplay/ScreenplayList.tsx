"use client";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { FileText, Loader2, CheckCircle, AlertCircle, Clock, ArrowRight } from "lucide-react";

interface Row {
	id: string;
	title: string;
	status: "pending" | "generating" | "ready" | "failed";
	updated_at: string;
}

const STATUS_CONFIG: Record<Row["status"], { icon: typeof Clock; cls: string; label: string }> = {
	pending: { icon: Clock, cls: "bg-yellow-100 text-yellow-700", label: "待機中" },
	generating: { icon: Loader2, cls: "bg-blue-100 text-blue-700", label: "生成中" },
	ready: { icon: CheckCircle, cls: "bg-green-100 text-green-700", label: "完成" },
	failed: { icon: AlertCircle, cls: "bg-red-100 text-red-700", label: "失敗" },
};

function formatStamp(iso: string): string {
	const d = new Date(iso);
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScreenplayList({ rows, locale }: { rows: Row[]; locale: string }) {
	if (rows.length === 0) {
		return (
			<Card className="border-gray-200">
				<CardContent className="py-16 flex flex-col items-center justify-center text-center">
					<div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-4">
						<FileText size={28} className="text-blue-600" />
					</div>
					<p className="text-gray-900 font-medium">まだ台本がありません</p>
					<p className="text-sm text-gray-500 mt-1">
						「新しい台本を作成」から、商品を選んで生成を開始してください。
					</p>
				</CardContent>
			</Card>
		);
	}
	return (
		<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
			{rows.map((r) => {
				const cfg = STATUS_CONFIG[r.status];
				const Icon = cfg.icon;
				return (
					<Link key={r.id} href={`/${locale}/screenplays/${r.id}`} className="group">
						<Card className="hover:shadow-md hover:border-blue-200 transition-all border-gray-200 h-full">
							<CardContent className="p-5">
								<div className="flex items-start justify-between gap-3 mb-3">
									<div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
										<FileText size={20} className="text-blue-600" />
									</div>
									<span className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full ${cfg.cls}`}>
										<Icon size={12} className={r.status === "generating" ? "animate-spin" : ""} />
										{cfg.label}
									</span>
								</div>
								<h3 className="font-semibold text-gray-900 truncate mb-1">{r.title}</h3>
								<div className="flex items-center justify-between mt-3">
									<p className="text-xs text-gray-400">{formatStamp(r.updated_at)}</p>
									<ArrowRight size={14} className="text-gray-300 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all" />
								</div>
							</CardContent>
						</Card>
					</Link>
				);
			})}
		</div>
	);
}
