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
	if (share >= 25) return "bg-rose-100 text-rose-700 border-rose-200";
	if (share >= 15) return "bg-amber-100 text-amber-700 border-amber-200";
	if (share >= 8) return "bg-blue-100 text-blue-700 border-blue-200";
	return "bg-gray-100 text-gray-600 border-gray-200";
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
		<div className="bg-white border border-gray-200 rounded-lg px-4 py-3 mb-4">
			<div className="flex items-center gap-2 mb-2 text-xs text-gray-500">
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
