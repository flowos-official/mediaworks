"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ContextSubTabs } from "@/components/discovery/ContextSubTabs";
import { SessionCalendar, type SessionRow } from "@/components/discovery/SessionCalendar";
import { useApiQuery } from "@/lib/client/api-cache";

type FilterContext = "all" | "home_shopping" | "live_commerce";

export default function DiscoveryHistoryPage() {
	const t = useTranslations("discovery");
	const [contextFilter, setContextFilter] = useState<FilterContext>("all");
	const [month, setMonth] = useState<Date>(new Date());
	const q = new URLSearchParams();
	if (contextFilter !== "all") q.set("context", contextFilter);
	const from = new Date(month.getFullYear(), month.getMonth() - 1, 1);
	const to = new Date(month.getFullYear(), month.getMonth() + 2, 0);
	q.set("from", from.toISOString());
	q.set("to", to.toISOString());
	const { data, isLoading: loading } = useApiQuery<{ sessions: SessionRow[] }>(
		`/api/discovery/history?${q}`,
	);
	const sessions = data?.sessions ?? [];

	return (
		<div className="space-y-4">
			<ContextSubTabs />

			<div className="mw-toolbar !flex-row !items-center">
				<span className="mw-data-label">{t("contextFilterLabel")}</span>
				{(["all", "home_shopping", "live_commerce"] as FilterContext[]).map((c) => (
					<button
						type="button"
						key={c}
						onClick={() => setContextFilter(c)}
						className={`min-h-8 rounded-lg border px-3 text-xs font-medium transition-colors ${
							contextFilter === c
								? "border-primary bg-primary text-primary-foreground"
								: "bg-card text-foreground border-border hover:bg-muted"
						}`}
					>
						{c === "all" ? "全て" : c === "home_shopping" ? "ホーム" : "ライブ"}
					</button>
				))}
				<div className="ml-auto flex items-center gap-2">
					<button
						type="button"
						aria-label="前月"
						onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
						className="inline-flex size-8 items-center justify-center rounded-lg border border-border bg-background text-xs hover:bg-muted"
					>
						←
					</button>
					<span className="text-xs text-muted-foreground font-mono">
						{month.getFullYear()}-{String(month.getMonth() + 1).padStart(2, "0")}
					</span>
					<button
						type="button"
						aria-label="翌月"
						onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
						className="inline-flex size-8 items-center justify-center rounded-lg border border-border bg-background text-xs hover:bg-muted"
					>
						→
					</button>
				</div>
			</div>

			{loading ? (
				<div className="mw-empty-state" role="status">{t("loadingResults")}</div>
			) : (
				<SessionCalendar sessions={sessions} month={month} />
			)}
		</div>
	);
}
