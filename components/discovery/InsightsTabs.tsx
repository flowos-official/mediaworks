"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { CheckSquare, BarChart3 } from "lucide-react";
import { SelectionGrid } from "./SelectionGrid";
import { StatsDashboard } from "./StatsDashboard";

type Tab = "selection" | "stats";

export function InsightsTabs() {
	const t = useTranslations("discovery");
	const [tab, setTab] = useState<Tab>("selection");

	return (
		<div>
			<div className="flex gap-1 p-1 bg-card border border-border rounded-lg shadow-sm mb-4 w-fit">
				<button
					type="button"
					onClick={() => setTab("selection")}
					className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
						tab === "selection"
							? "bg-indigo-500 text-white shadow-sm"
							: "text-muted-foreground hover:text-foreground hover:bg-muted"
					}`}
				>
					<CheckSquare size={14} />
					{t("insightsSelectionTab")}
				</button>
				<button
					type="button"
					onClick={() => setTab("stats")}
					className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
						tab === "stats"
							? "bg-indigo-500 text-white shadow-sm"
							: "text-muted-foreground hover:text-foreground hover:bg-muted"
					}`}
				>
					<BarChart3 size={14} />
					{t("insightsStatsTab")}
				</button>
			</div>

			{tab === "selection" ? <SelectionGrid /> : <StatsDashboard />}
		</div>
	);
}
