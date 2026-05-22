"use client";

import { BarChart3 } from "lucide-react";
import { useTranslations } from "next-intl";

export interface CategoryShare {
	category: string;
	count: number;
	share: number;
}

export interface CategoryFrequencyStripProps {
	stats: {
		lookbackDays: number;
		totalSlots: number;
		categories: CategoryShare[];
	} | null;
	matchedCategories?: Set<string>;
}

function shareColor(share: number): string {
	if (share >= 25) return "bg-rose-600/15 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-900/40";
	if (share >= 15) return "bg-amber-600/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-900/40";
	if (share >= 8) return "bg-blue-600/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900/40";
	return "bg-muted text-muted-foreground border-border";
}

export function CategoryFrequencyStrip({
	stats,
	matchedCategories,
}: CategoryFrequencyStripProps) {
	const t = useTranslations("discovery");
	if (!stats || stats.totalSlots === 0 || stats.categories.length === 0) {
		return null;
	}

	return (
		<div className="bg-card border border-border rounded-lg px-4 py-3 mb-4">
			<div className="flex items-center gap-2 mb-2 text-xs text-muted-foreground">
				<BarChart3 size={12} />
				<span>
					{t("categoryShareTitle", {
						days: stats.lookbackDays,
						slots: stats.totalSlots,
					})}
				</span>
			</div>
			<div className="flex flex-wrap gap-1.5">
				{stats.categories.map((c) => {
					const matched = matchedCategories?.has(c.category) ?? false;
					return (
						<span
							key={c.category}
							className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs ${shareColor(c.share)} ${matched ? "ring-2 ring-offset-1 ring-rose-300" : ""}`}
							title={t("categoryShareTooltip", {
								count: c.count,
								share: c.share,
							})}
						>
							<span className="font-medium">{c.category}</span>
							<span className="font-mono tabular-nums">{c.share}%</span>
						</span>
					);
				})}
			</div>
		</div>
	);
}
