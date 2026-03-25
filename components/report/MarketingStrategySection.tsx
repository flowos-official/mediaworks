"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Megaphone, ChevronDown, ChevronUp } from "lucide-react";

interface MarketingStrategy {
	strategy_name: string;
	type: string;
	estimated_cost: string;
	expected_reach: string;
	efficiency_score: number;
	steps: string[];
	best_for_channels: string[];
}

const TYPE_COLORS: Record<string, string> = {
	"SNS": "bg-pink-100 text-pink-800",
	"インフルエンサー": "bg-purple-100 text-purple-800",
	"PR": "bg-blue-100 text-blue-800",
	"SEO": "bg-green-100 text-green-800",
	"イベント": "bg-orange-100 text-orange-800",
};

function EfficiencyBar({ score }: { score: number }) {
	const color =
		score >= 80 ? "bg-green-500" :
		score >= 60 ? "bg-blue-500" :
		score >= 40 ? "bg-yellow-500" : "bg-red-400";
	return (
		<div className="flex items-center gap-2">
			<div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
				<div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
			</div>
			<span className="text-[10px] font-bold text-gray-500 tabular-nums w-6 text-right">{score}</span>
		</div>
	);
}

interface MarketingStrategySectionProps {
	strategies: MarketingStrategy[];
}

export default function MarketingStrategySection({ strategies }: MarketingStrategySectionProps) {
	const t = useTranslations("report");
	if (!strategies || strategies.length === 0) return null;
	const [expanded, setExpanded] = useState<number | null>(null);

	const sorted = [...strategies].sort((a, b) => b.efficiency_score - a.efficiency_score);

	return (
		<Card>
			<CardContent className="p-6">
				<div className="flex items-center gap-2 mb-5">
					<Megaphone className="h-5 w-5 text-purple-500" />
					<h3 className="text-lg font-semibold text-gray-900">{t("marketing.title")}</h3>
					<span className="text-xs text-gray-400 ml-auto">{t("marketing.sortedByEfficiency")}</span>
				</div>
				<div className="space-y-3">
					{sorted.map((s, i) => (
						<div key={s.strategy_name || i} className="border border-gray-100 rounded-xl overflow-hidden">
							<button
								type="button"
								className="w-full text-left p-4 hover:bg-gray-50 transition-colors"
								onClick={() => setExpanded(expanded === i ? null : i)}
							>
								<div className="flex items-start justify-between gap-3">
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2 mb-1">
											<span className="font-semibold text-sm truncate">{s.strategy_name}</span>
											<Badge className={`text-[10px] shrink-0 ${TYPE_COLORS[s.type] ?? "bg-gray-100 text-gray-600"}`}>
												{s.type}
											</Badge>
										</div>
										<div className="flex items-center gap-4 text-xs text-gray-500">
											<span>{t("marketing.budget")} {s.estimated_cost}</span>
											<span>{t("marketing.reach")} {s.expected_reach}</span>
										</div>
										<div className="mt-2">
											<EfficiencyBar score={s.efficiency_score} />
										</div>
									</div>
									<span data-pdf-hide>
									{expanded === i ? (
										<ChevronUp className="h-4 w-4 text-gray-400 shrink-0 mt-1" />
									) : (
										<ChevronDown className="h-4 w-4 text-gray-400 shrink-0 mt-1" />
									)}
								</span>
								</div>
							</button>
							<div
								className={`px-4 pb-4 border-t border-gray-100 pt-3 bg-gray-50/50 ${expanded !== i ? "hidden" : ""}`}
								data-pdf-accordion
							>
								{s.steps?.length > 0 && (
									<div className="mb-3">
										<p className="text-xs font-semibold text-gray-500 mb-2">{t("marketing.executionSteps")}</p>
										<ol className="space-y-1">
											{s.steps.map((step, si) => (
												<li key={si} className="flex items-start gap-2 text-xs text-gray-600">
													<span className="font-bold text-gray-400 shrink-0">{si + 1}.</span>
													{step}
												</li>
											))}
										</ol>
									</div>
								)}
								{s.best_for_channels?.length > 0 && (
									<div>
										<p className="text-xs font-semibold text-gray-500 mb-1.5">{t("marketing.recommendedChannels")}</p>
										<div className="flex flex-wrap gap-1">
											{s.best_for_channels.map((ch) => (
												<span key={ch} className="text-[10px] bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full">
													{ch}
												</span>
											))}
										</div>
									</div>
								)}
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
