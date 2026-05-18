"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ContextSubTabs } from "@/components/discovery/ContextSubTabs";
import { SessionCalendar, type SessionRow } from "@/components/discovery/SessionCalendar";
import { SessionList } from "@/components/discovery/SessionList";

type FilterContext = "all" | "home_shopping" | "live_commerce";

export default function DiscoveryHistoryPage() {
	const t = useTranslations("discovery");
	const [sessions, setSessions] = useState<SessionRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [contextFilter, setContextFilter] = useState<FilterContext>("all");
	const [month, setMonth] = useState<Date>(new Date());

	useEffect(() => {
		let cancelled = false;
		async function load() {
			setLoading(true);
			const q = new URLSearchParams();
			if (contextFilter !== "all") q.set("context", contextFilter);
			const from = new Date(month.getFullYear(), month.getMonth() - 1, 1);
			const to = new Date(month.getFullYear(), month.getMonth() + 2, 0);
			q.set("from", from.toISOString());
			q.set("to", to.toISOString());

			const res = await fetch(`/api/discovery/history?${q}`);
			const data = await res.json();
			if (!cancelled) {
				setSessions(data.sessions ?? []);
				setLoading(false);
			}
		}
		load();
		return () => {
			cancelled = true;
		};
	}, [contextFilter, month]);

	return (
		<div>
			<ContextSubTabs />

			<div className="flex items-center gap-2 mb-4 flex-wrap">
				<span className="text-xs text-gray-500">Context:</span>
				{(["all", "home_shopping", "live_commerce"] as FilterContext[]).map((c) => (
					<button
						key={c}
						onClick={() => setContextFilter(c)}
						className={`px-3 py-1 text-xs rounded-full border transition-colors ${
							contextFilter === c
								? "bg-amber-500 text-white border-amber-500"
								: "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
						}`}
					>
						{c === "all" ? "全て" : c === "home_shopping" ? "ホーム" : "ライブ"}
					</button>
				))}
				<div className="ml-auto flex items-center gap-2">
					<button
						onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
						className="px-2 py-1 text-xs bg-white border border-gray-200 rounded hover:bg-gray-50"
					>
						←
					</button>
					<span className="text-xs text-gray-600 font-mono">
						{month.getFullYear()}-{String(month.getMonth() + 1).padStart(2, "0")}
					</span>
					<button
						onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
						className="px-2 py-1 text-xs bg-white border border-gray-200 rounded hover:bg-gray-50"
					>
						→
					</button>
				</div>
			</div>

			{loading ? (
				<div className="py-20 text-center text-sm text-gray-500">Loading...</div>
			) : (
				<div className="space-y-4">
					<SessionCalendar sessions={sessions} month={month} />
					<SessionList sessions={sessions} />
				</div>
			)}
		</div>
	);
}
