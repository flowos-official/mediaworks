"use client";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

interface Insight {
	week_start: string;
	context: "home_shopping" | "live_commerce";
	sourced_product_patterns: string | null;
	exploration_wins: string | null;
	next_week_suggestions: string | null;
	sourced_count: number | null;
	rejected_count: number | null;
}

export function WeeklyInsightCard({ insight }: { insight: Insight | null }) {
	const t = useTranslations("discovery");

	if (!insight) {
		return (
			<div className="bg-white border border-gray-200 rounded-lg p-5 text-sm text-gray-400">
				{t("noData")}
			</div>
		);
	}

	return (
		<div className="bg-gradient-to-br from-indigo-50 to-white border border-indigo-200 rounded-lg p-5">
			<div className="flex items-center gap-2 mb-3">
				<Sparkles size={14} className="text-indigo-600" />
				<h3 className="text-sm font-semibold text-gray-900">{t("weeklyInsightTitle")}</h3>
				<span className="text-[10px] text-gray-500 ml-auto">
					{insight.week_start}~ · {insight.context === "home_shopping" ? "ホーム" : "ライブ"}
				</span>
			</div>
			<div className="space-y-3">
				<Section label={t("weeklyInsightHighlight")} text={insight.sourced_product_patterns} />
				<Section label={t("weeklyInsightPatterns")} text={insight.exploration_wins} />
				<Section label={t("weeklyInsightSuggestions")} text={insight.next_week_suggestions} />
			</div>
		</div>
	);
}

function Section({ label, text }: { label: string; text: string | null }) {
	if (!text) return null;
	return (
		<div>
			<div className="text-[10px] font-bold text-indigo-700 uppercase tracking-wide mb-1">
				{label}
			</div>
			<p className="text-xs text-gray-800 leading-relaxed">{text}</p>
		</div>
	);
}
