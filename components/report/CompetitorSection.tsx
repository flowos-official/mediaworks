"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface Competitor {
	name: string;
	price: string;
	platform: string;
	key_difference: string;
}

interface CompetitorSectionProps {
	competitors: Competitor[];
	recommendedPriceRange: string;
}

export default function CompetitorSection({
	competitors,
	recommendedPriceRange,
}: CompetitorSectionProps) {
	const t = useTranslations("report");
	if (!competitors || competitors.length === 0) return null;

	return (
		<Card>
			<CardContent className="p-6">
				<h3 className="text-lg font-semibold text-foreground mb-4">
					{t("competitor.title")}
				</h3>

				{recommendedPriceRange && (
					<div className="mb-4 p-3 bg-blue-600/10 rounded-lg">
						<p className="text-sm text-blue-800 dark:text-blue-300">
							<span className="font-semibold">{t("competitor.recommendedPrice")}</span>{" "}
							{recommendedPriceRange}
						</p>
					</div>
				)}

				<div className="space-y-3">
					{competitors.map((comp, i) => (
						<div
							key={comp.name || i}
							className="flex items-start gap-4 p-3 bg-muted rounded-lg"
						>
							<div className="w-8 h-8 bg-accent rounded-full flex items-center justify-center text-sm font-bold text-muted-foreground">
								{i + 1}
							</div>
							<div className="flex-1">
								<div className="flex items-center gap-2 mb-1">
									<span className="font-semibold text-sm">{comp.name}</span>
									<Badge variant="outline" className="text-xs">
										{comp.platform}
									</Badge>
								</div>
								<p className="text-sm text-muted-foreground">{comp.price}</p>
								<p className="text-xs text-muted-foreground mt-1">{comp.key_difference}</p>
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
