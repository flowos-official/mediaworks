"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";

interface JapanExportSectionProps {
	score: number;
	recommendedPriceRange: string;
}

function getScoreColor(score: number): string {
	if (score >= 80) return "text-green-600 bg-green-50";
	if (score >= 60) return "text-blue-600 bg-blue-50";
	if (score >= 40) return "text-yellow-600 bg-yellow-50";
	return "text-red-600 bg-red-50";
}

export default function JapanExportSection({
	score,
	recommendedPriceRange,
}: JapanExportSectionProps) {
	const t = useTranslations("report");
	if (score == null) return null;

	const colorClass = getScoreColor(score);
	const label =
		score >= 80 ? t("japanExport.veryFit") :
		score >= 60 ? t("japanExport.fit") :
		score >= 40 ? t("japanExport.average") : t("japanExport.unfit");

	return (
		<Card>
			<CardContent className="p-6">
				<h3 className="text-lg font-semibold text-gray-900 mb-4">
					{t("japanExport.title")}
				</h3>

				<div className="flex items-center gap-6">
					<div
						className={`w-24 h-24 rounded-full flex flex-col items-center justify-center ${colorClass}`}
					>
						<span className="text-3xl font-bold">{score}</span>
						<span className="text-xs font-medium">/100</span>
					</div>

					<div className="flex-1">
						<p className="text-lg font-semibold">{label}</p>
						{recommendedPriceRange && (
							<p className="text-sm text-gray-600 mt-1">
								{t("japanExport.recommendedPrice")} {recommendedPriceRange}
							</p>
						)}
						<div className="mt-3 h-2 bg-gray-100 rounded-full overflow-hidden">
							<div
								className={`h-full rounded-full transition-all duration-500 ${
									score >= 60 ? "bg-green-500" : score >= 40 ? "bg-yellow-500" : "bg-red-500"
								}`}
								style={{ width: `${score}%` }}
							/>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
