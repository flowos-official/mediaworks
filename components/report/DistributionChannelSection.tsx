"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp } from "lucide-react";

interface Channel {
	channel_name: string;
	channel_type: string;
	primary_age_group: string;
	fit_score: number;
	reason: string;
	monthly_visitors?: string;
	commission_rate?: string;
}

const TYPE_COLORS: Record<string, string> = {
	"EC": "bg-blue-100 text-blue-800",
	"TVホームショッピング": "bg-purple-100 text-purple-800",
	"TV홈쇼핑": "bg-purple-100 text-purple-800",
	"SNSコマース": "bg-pink-100 text-pink-800",
	"SNS커머스": "bg-pink-100 text-pink-800",
	"オフライン": "bg-orange-100 text-orange-800",
	"오프라인": "bg-orange-100 text-orange-800",
};

function ScoreBar({ score }: { score: number }) {
	const color =
		score >= 80 ? "bg-green-500" :
		score >= 60 ? "bg-blue-500" :
		score >= 40 ? "bg-yellow-500" : "bg-red-400";

	return (
		<div className="flex items-center gap-2">
			<div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
				<div
					className={`h-full rounded-full transition-all ${color}`}
					style={{ width: `${score}%` }}
				/>
			</div>
			<span className="text-xs font-bold tabular-nums w-8 text-right">{score}</span>
		</div>
	);
}

interface DistributionChannelSectionProps {
	channels: Channel[];
}

export default function DistributionChannelSection({ channels }: DistributionChannelSectionProps) {
	const t = useTranslations("report");
	if (!channels || channels.length === 0) return null;

	const sorted = [...channels].sort((a, b) => b.fit_score - a.fit_score);

	return (
		<Card>
			<CardContent className="p-6">
				<div className="flex items-center gap-2 mb-5">
					<TrendingUp className="h-5 w-5 text-blue-500" />
					<h3 className="text-lg font-semibold text-gray-900">{t("distribution.title")}</h3>
				</div>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					{sorted.map((ch, i) => (
						<div
							key={ch.channel_name || i}
							className="border border-gray-100 rounded-xl p-4 bg-gray-50/50"
						>
							<div className="flex items-start justify-between mb-3">
								<div>
									<h4 className="font-semibold text-sm">{ch.channel_name}</h4>
									<p className="text-xs text-gray-500 mt-0.5">{ch.primary_age_group}</p>
								</div>
								<Badge
									className={`text-[10px] ${TYPE_COLORS[ch.channel_type] ?? "bg-gray-100 text-gray-600"}`}
								>
									{ch.channel_type}
								</Badge>
							</div>
							<div className="mb-3">
								<div className="flex items-center justify-between text-xs text-gray-500 mb-1">
									<span>{t("distribution.fitScore")}</span>
								</div>
								<ScoreBar score={ch.fit_score} />
							</div>
							<p className="text-xs text-gray-600 leading-relaxed">{ch.reason}</p>
							{(ch.monthly_visitors || ch.commission_rate) && (
								<div className="flex gap-3 mt-3 text-[11px] text-gray-400">
									{ch.monthly_visitors && (
										<span>{t("distribution.visitors")} {ch.monthly_visitors}</span>
									)}
									{ch.commission_rate && (
										<span>{t("distribution.commission")} {ch.commission_rate}</span>
									)}
								</div>
							)}
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
