"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Home, Tv } from "lucide-react";
import type { SessionRow } from "./SessionCalendar";

function statusBadge(status: SessionRow["status"]): { label: string; color: string } {
	switch (status) {
		case "completed":
			return { label: "完了", color: "bg-green-100 text-green-700" };
		case "partial":
			return { label: "部分", color: "bg-yellow-100 text-yellow-700" };
		case "failed":
			return { label: "失敗", color: "bg-red-100 text-red-700" };
		default:
			return { label: "実行中", color: "bg-blue-100 text-blue-700" };
	}
}

export function SessionList({ sessions }: { sessions: SessionRow[] }) {
	const { locale } = useParams<{ locale: string }>();

	if (sessions.length === 0) {
		return (
			<div className="bg-white border border-gray-200 rounded-lg py-10 text-center text-sm text-gray-400">
				(履歴なし)
			</div>
		);
	}

	return (
		<div className="bg-white border border-gray-200 rounded-lg divide-y divide-gray-100">
			{sessions.map((s) => {
				const badge = statusBadge(s.status);
				const isHome = s.context === "home_shopping";
				return (
					<Link
						key={s.id}
						href={`/${locale}/analytics/discovery/session/${s.id}`}
						className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors text-sm"
					>
						<span className="text-xs font-mono text-gray-500 w-32 shrink-0">
							{new Date(s.run_at).toLocaleString("ja-JP")}
						</span>
						<span
							className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold ${
								isHome
									? "bg-blue-50 text-blue-700 border border-blue-200"
									: "bg-purple-50 text-purple-700 border border-purple-200"
							}`}
						>
							{isHome ? <Home size={9} /> : <Tv size={9} />}
							{isHome ? "ホーム" : "ライブ"}
						</span>
						<span className={`text-[10px] px-2 py-0.5 rounded-full ${badge.color}`}>
							{badge.label}
						</span>
						<span className="text-xs text-gray-600">{s.produced_count}件</span>
						<span className="ml-auto text-xs text-blue-600">詳細 →</span>
					</Link>
				);
			})}
		</div>
	);
}
