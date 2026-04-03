"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Tv, ShoppingCart, Share2, MoreHorizontal, ExternalLink } from "lucide-react";

interface Channel {
	channel_name: string;
	channel_type: string;
	primary_age_group: string;
	fit_score: number;
	reason: string;
	monthly_visitors?: string;
	commission_rate?: string;
	url?: string;
	broadcaster?: string;
}

const TYPE_CONFIG: Record<string, { color: string; icon: typeof Tv; groupKey: string }> = {
	"TV通販": { color: "bg-purple-100 text-purple-800", icon: Tv, groupKey: "tvShopping" },
	"TVホームショッピング": { color: "bg-purple-100 text-purple-800", icon: Tv, groupKey: "tvShopping" },
	"TV홈쇼핑": { color: "bg-purple-100 text-purple-800", icon: Tv, groupKey: "tvShopping" },
	"EC": { color: "bg-blue-100 text-blue-800", icon: ShoppingCart, groupKey: "ec" },
	"カタログ通販": { color: "bg-blue-100 text-blue-800", icon: ShoppingCart, groupKey: "ec" },
	"クラウドファンディング": { color: "bg-blue-100 text-blue-800", icon: ShoppingCart, groupKey: "ec" },
	"SNSコマース": { color: "bg-pink-100 text-pink-800", icon: Share2, groupKey: "sns" },
	"SNS커머스": { color: "bg-pink-100 text-pink-800", icon: Share2, groupKey: "sns" },
	"オフライン": { color: "bg-orange-100 text-orange-800", icon: MoreHorizontal, groupKey: "other" },
	"오프라인": { color: "bg-orange-100 text-orange-800", icon: MoreHorizontal, groupKey: "other" },
	"その他": { color: "bg-gray-100 text-gray-800", icon: MoreHorizontal, groupKey: "other" },
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

function ChannelCard({ ch, t }: { ch: Channel; t: ReturnType<typeof useTranslations> }) {
	const cfg = TYPE_CONFIG[ch.channel_type] ?? TYPE_CONFIG["その他"];

	return (
		<div className="border border-gray-100 rounded-xl p-4 bg-gray-50/50">
			<div className="flex items-start justify-between mb-3">
				<div>
					<h4 className="font-semibold text-sm">{ch.channel_name}</h4>
					{ch.broadcaster && (
						<p className="text-[11px] text-gray-400 mt-0.5">{ch.broadcaster}</p>
					)}
					<p className="text-xs text-gray-500 mt-0.5">{ch.primary_age_group}</p>
				</div>
				<Badge className={`text-[10px] ${cfg.color}`}>
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
			<div className="flex items-center justify-between mt-3">
				<div className="flex gap-3 text-[11px] text-gray-400">
					{ch.monthly_visitors && (
						<span>{t("distribution.visitors")} {ch.monthly_visitors}</span>
					)}
					{ch.commission_rate && (
						<span>{t("distribution.commission")} {ch.commission_rate}</span>
					)}
				</div>
				{ch.url && (
					<a
						href={ch.url}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-1 text-[11px] text-blue-500 hover:text-blue-700 transition-colors"
					>
						<ExternalLink size={10} />
						{t("distribution.visitSite")}
					</a>
				)}
			</div>
		</div>
	);
}

const GROUP_ORDER = ["tvShopping", "ec", "sns", "other"];

const GROUP_ICONS: Record<string, typeof Tv> = {
	tvShopping: Tv,
	ec: ShoppingCart,
	sns: Share2,
	other: MoreHorizontal,
};

interface DistributionChannelSectionProps {
	channels: Channel[];
}

export default function DistributionChannelSection({ channels }: DistributionChannelSectionProps) {
	const t = useTranslations("report");
	if (!channels || channels.length === 0) return null;

	// Group channels by type
	const groups: Record<string, Channel[]> = {};
	for (const ch of channels) {
		const cfg = TYPE_CONFIG[ch.channel_type] ?? TYPE_CONFIG["その他"];
		const groupKey = cfg.groupKey;
		if (!groups[groupKey]) groups[groupKey] = [];
		groups[groupKey].push(ch);
	}

	// Sort within each group by fit_score desc
	for (const key of Object.keys(groups)) {
		groups[key].sort((a, b) => b.fit_score - a.fit_score);
	}

	return (
		<Card>
			<CardContent className="p-6">
				<div className="flex items-center gap-2 mb-5">
					<TrendingUp className="h-5 w-5 text-blue-500" />
					<h3 className="text-lg font-semibold text-gray-900">{t("distribution.title")}</h3>
				</div>

				<div className="space-y-6">
					{GROUP_ORDER.map((groupKey) => {
						const groupChannels = groups[groupKey];
						if (!groupChannels || groupChannels.length === 0) return null;

						const Icon = GROUP_ICONS[groupKey] ?? MoreHorizontal;

						return (
							<div key={groupKey}>
								<div className="flex items-center gap-2 mb-3">
									<Icon size={16} className="text-gray-500" />
									<h4 className="text-sm font-semibold text-gray-700">
										{t(`distribution.${groupKey}` as "distribution.tvShopping" | "distribution.ec" | "distribution.sns" | "distribution.other")}
									</h4>
									<span className="text-xs text-gray-400">({groupChannels.length})</span>
								</div>
								<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
									{groupChannels.map((ch, i) => (
										<ChannelCard key={ch.channel_name || i} ch={ch} t={t} />
									))}
								</div>
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
