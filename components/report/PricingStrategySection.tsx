"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { CircleDollarSign } from "lucide-react";

interface ChannelPricing {
	channel: string;
	benchmark_price: string;
	recommended_price: string;
	estimated_margin_pct: number;
	reason: string;
}

interface BepChannel {
	channel: string;
	bep_units: number;
	bep_revenue: string;
}

interface PricingStrategy {
	channel_pricing: ChannelPricing[];
	bep_analysis: {
		estimated_cogs_per_unit: string;
		fixed_cost_assumption: string;
		bep_units_per_channel: BepChannel[];
		summary: string;
	};
}

interface PricingStrategySectionProps {
	pricingStrategy: PricingStrategy;
}

export default function PricingStrategySection({ pricingStrategy }: PricingStrategySectionProps) {
	const t = useTranslations("report");
	if (!pricingStrategy) return null;
	const [tab, setTab] = useState<"pricing" | "bep">("pricing");
	const { channel_pricing, bep_analysis } = pricingStrategy;

	return (
		<Card>
			<CardContent className="p-6">
				<div className="flex items-center gap-2 mb-5">
					<CircleDollarSign className="h-5 w-5 text-emerald-500" />
					<h3 className="text-lg font-semibold text-foreground">{t("pricing.title")}</h3>
				</div>

				{/* Tab switcher */}
				<div className="flex gap-1 p-1 bg-muted rounded-lg w-fit mb-5" data-pdf-hide>
					{(["pricing", "bep"] as const).map((tabKey) => (
						<button
							key={tabKey}
							type="button"
							onClick={() => setTab(tabKey)}
							className={`px-4 py-1.5 text-sm font-medium rounded-md transition-colors ${
								tab === tabKey ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
							}`}
						>
							{tabKey === "pricing" ? t("pricing.channelPricing") : t("pricing.bepAnalysis")}
						</button>
					))}
				</div>

				{/* Pricing Table */}
				<div className={tab !== "pricing" ? "hidden" : ""} data-pdf-tab="pricing">
					<p className="hidden pdf-tab-label text-xs font-semibold text-emerald-600 mb-3">
						【{t("pricing.channelPricing")}】
					</p>
					{channel_pricing?.length > 0 && (
						<div className="overflow-x-auto">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b border-border text-xs text-muted-foreground uppercase tracking-wide">
										<th className="pb-2 text-left">{t("pricing.channel")}</th>
										<th className="pb-2 text-right">{t("pricing.benchmark")}</th>
										<th className="pb-2 text-right">{t("pricing.recommended")}</th>
										<th className="pb-2 text-right">{t("pricing.margin")}</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-border">
									{channel_pricing.map((cp, i) => (
										<tr key={cp.channel || i}>
											<td className="py-3 font-medium">{cp.channel}</td>
											<td className="py-3 text-right text-muted-foreground">{cp.benchmark_price}</td>
											<td className="py-3 text-right font-semibold text-emerald-700 dark:text-emerald-400">{cp.recommended_price}</td>
											<td className="py-3 text-right">
												<span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
													cp.estimated_margin_pct >= 30
														? "bg-green-600/10 text-green-800 dark:text-green-300"
														: cp.estimated_margin_pct >= 15
														? "bg-blue-600/10 text-blue-800 dark:text-blue-300"
														: "bg-orange-600/10 text-orange-800 dark:text-orange-300"
												}`}>
													{cp.estimated_margin_pct}%
												</span>
											</td>
										</tr>
									))}
								</tbody>
							</table>
							{channel_pricing[0]?.reason && (
								<p className="text-xs text-muted-foreground mt-3 pt-3 border-t border-border">
									{channel_pricing[0].reason}
								</p>
							)}
						</div>
					)}
				</div>

				{/* BEP Analysis */}
				<div className={`${tab !== "bep" ? "hidden" : ""} mt-5`} data-pdf-tab="bep">
					<p className="hidden pdf-tab-label text-xs font-semibold text-emerald-600 mb-3">
						【{t("pricing.bepAnalysis")}】
					</p>
					{bep_analysis && (
						<div>
							<div className="grid grid-cols-2 gap-3 mb-5">
								<div className="bg-blue-600/10 rounded-xl p-4">
									<p className="text-xs text-blue-600 dark:text-blue-300 mb-1">{t("pricing.unitCost")}</p>
									<p className="font-bold text-blue-900 dark:text-blue-200">{bep_analysis.estimated_cogs_per_unit}</p>
								</div>
								<div className="bg-orange-600/10 rounded-xl p-4">
									<p className="text-xs text-orange-600 dark:text-orange-300 mb-1">{t("pricing.fixedCost")}</p>
									<p className="font-bold text-orange-900 dark:text-orange-200">{bep_analysis.fixed_cost_assumption}</p>
								</div>
							</div>
							{bep_analysis.bep_units_per_channel?.length > 0 && (
								<div className="space-y-2 mb-4">
									{bep_analysis.bep_units_per_channel.map((b, i) => (
										<div key={b.channel || i} className="flex items-center justify-between text-sm bg-muted rounded-lg px-4 py-3">
											<span className="font-medium">{b.channel}</span>
											<div className="flex items-center gap-4 text-right">
												<span className="text-muted-foreground text-xs">{t("pricing.bepUnits", { count: b.bep_units })}</span>
												<span className="font-semibold">{b.bep_revenue}</span>
											</div>
										</div>
									))}
								</div>
							)}
							{bep_analysis.summary && (
								<p className="text-xs text-muted-foreground leading-relaxed">{bep_analysis.summary}</p>
							)}
						</div>
					)}
				</div>
			</CardContent>
		</Card>
	);
}
