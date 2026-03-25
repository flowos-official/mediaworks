"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Flag } from "lucide-react";

interface KoreaChannel {
	channel_name: string;
	target_age: string;
	strategy: string;
	estimated_entry_cost: string;
}

interface KoreaMarketFit {
	fit_score: number;
	target_products: string[];
	recommended_channels: KoreaChannel[];
	korean_consumer_insight: string;
}

function FitGauge({ score, label }: { score: number; label: string }) {
	const color =
		score >= 80 ? "bg-green-500" :
		score >= 60 ? "bg-blue-500" :
		score >= 40 ? "bg-yellow-500" : "bg-red-400";

	return (
		<div className="flex items-center gap-5">
			<div
				className={`w-20 h-20 rounded-full flex flex-col items-center justify-center ${
					score >= 80 ? "bg-green-50" :
					score >= 60 ? "bg-blue-50" :
					score >= 40 ? "bg-yellow-50" : "bg-red-50"
				}`}
			>
				<span className={`text-2xl font-bold ${
					score >= 80 ? "text-green-700" :
					score >= 60 ? "text-blue-700" :
					score >= 40 ? "text-yellow-700" : "text-red-700"
				}`}>
					{score}
				</span>
				<span className="text-[10px] text-gray-500">/100</span>
			</div>
			<div>
				<p className="text-lg font-semibold">{label}</p>
				<div className="mt-2 h-2 w-48 bg-gray-100 rounded-full overflow-hidden">
					<div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
				</div>
			</div>
		</div>
	);
}

interface KoreaMarketSectionProps {
	koreaMarket: KoreaMarketFit;
}

export default function KoreaMarketSection({ koreaMarket }: KoreaMarketSectionProps) {
	const t = useTranslations("report");
	if (!koreaMarket) return null;

	const fitLabel =
		koreaMarket.fit_score >= 80 ? t("japanExport.veryFit") :
		koreaMarket.fit_score >= 60 ? t("japanExport.fit") :
		koreaMarket.fit_score >= 40 ? t("japanExport.average") : t("japanExport.unfit");

	return (
		<Card>
			<CardContent className="p-6">
				<div className="flex items-center gap-2 mb-5">
					<Flag className="h-5 w-5 text-red-500" />
					<h3 className="text-lg font-semibold text-gray-900">{t("koreaMarket.title")}</h3>
				</div>

				{/* Score gauge */}
				<div className="mb-6">
					<FitGauge score={koreaMarket.fit_score} label={fitLabel} />
				</div>

				{/* Target products */}
				{koreaMarket.target_products?.length > 0 && (
					<div className="mb-5">
						<p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
							{t("koreaMarket.targetProducts")}
						</p>
						<div className="flex flex-wrap gap-2">
							{koreaMarket.target_products.map((p, i) => (
								<span
									key={i}
									className="text-xs bg-red-50 text-red-700 px-3 py-1 rounded-full font-medium"
								>
									{p}
								</span>
							))}
						</div>
					</div>
				)}

				{/* Recommended channels */}
				{koreaMarket.recommended_channels?.length > 0 && (
					<div className="mb-5">
						<p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
							{t("koreaMarket.recommendedChannels")}
						</p>
						<div className="grid grid-cols-1 md:grid-cols-2 gap-3">
							{koreaMarket.recommended_channels.map((ch, i) => (
								<div key={ch.channel_name || i} className="bg-gray-50 rounded-xl p-4">
									<div className="flex items-start justify-between mb-2">
										<span className="font-semibold text-sm">{ch.channel_name}</span>
										<span className="text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
											{ch.target_age}
										</span>
									</div>
									<p className="text-xs text-gray-600 mb-2">{ch.strategy}</p>
									<p className="text-[11px] text-gray-400">
										{t("koreaMarket.entryCost")} {ch.estimated_entry_cost}
									</p>
								</div>
							))}
						</div>
					</div>
				)}

				{/* Consumer insight */}
				{koreaMarket.korean_consumer_insight && (
					<div className="bg-blue-50 rounded-xl p-4">
						<p className="text-xs font-semibold text-blue-700 mb-1">{t("koreaMarket.consumerInsight")}</p>
						<p className="text-sm text-blue-800 leading-relaxed">
							{koreaMarket.korean_consumer_insight}
						</p>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
