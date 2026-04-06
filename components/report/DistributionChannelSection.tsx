"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { TrendingUp, Tv, ShoppingCart, Share2, MoreHorizontal, ExternalLink, Newspaper, ChevronDown, ChevronUp } from "lucide-react";

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
	evidence_sources?: Array<{ title: string; url: string; snippet: string }>;
	similar_products_on_channel?: Array<{ product_name: string; price?: string; source_url?: string }>;
	scoring_breakdown?: {
		demographic_match: number;
		category_track_record: number;
		price_point_fit: number;
		presentation_format_fit: number;
	};
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
	"メディア": { color: "bg-amber-100 text-amber-800", icon: Newspaper, groupKey: "media" },
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

const BREAKDOWN_ITEMS = [
	{ key: "demographic_match" as const, labelKey: "demographicMatch", color: "bg-blue-500" },
	{ key: "category_track_record" as const, labelKey: "categoryTrackRecord", color: "bg-green-500" },
	{ key: "price_point_fit" as const, labelKey: "pricePointFit", color: "bg-amber-500" },
	{ key: "presentation_format_fit" as const, labelKey: "presentationFit", color: "bg-purple-500" },
];

function ScoringBreakdown({ breakdown, t }: { breakdown: NonNullable<Channel["scoring_breakdown"]>; t: ReturnType<typeof useTranslations> }) {
	return (
		<div className="mt-3 space-y-1.5">
			{BREAKDOWN_ITEMS.map(({ key, labelKey, color }) => (
				<div key={key} className="flex items-center gap-2">
					<span className="text-[10px] text-gray-500 w-20 shrink-0">{t(`distribution.${labelKey}` as `distribution.${typeof labelKey}`)}</span>
					<div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
						<div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min((breakdown[key] / 25) * 100, 100)}%` }} />
					</div>
					<span className="text-[10px] font-medium tabular-nums w-8 text-right">{breakdown[key]}/25</span>
				</div>
			))}
		</div>
	);
}

function ChannelCard({ ch, t }: { ch: Channel; t: ReturnType<typeof useTranslations> }) {
	const cfg = TYPE_CONFIG[ch.channel_type] ?? TYPE_CONFIG["その他"];
	const [showEvidence, setShowEvidence] = useState(false);
	const hasEvidence = ch.evidence_sources && ch.evidence_sources.length > 0;
	const hasSimilar = ch.similar_products_on_channel && ch.similar_products_on_channel.length > 0;

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

			{ch.scoring_breakdown && (
				<ScoringBreakdown breakdown={ch.scoring_breakdown} t={t} />
			)}

			<p className="text-xs text-gray-600 leading-relaxed mt-3">{ch.reason}</p>

			{hasSimilar && (
				<div className="mt-3">
					<p className="text-[10px] font-medium text-gray-500 mb-1.5">{t("distribution.similarProducts")}</p>
					<div className="flex flex-wrap gap-1.5">
						{ch.similar_products_on_channel!.map((sp, i) => (
							<span key={i} className="inline-flex items-center gap-1">
								{sp.source_url ? (
									<a href={sp.source_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[10px] bg-green-50 text-green-700 border border-green-200 rounded-full px-2 py-0.5 hover:bg-green-100 transition-colors">
										{sp.product_name}{sp.price && ` (${sp.price})`}
										<ExternalLink size={8} />
									</a>
								) : (
									<Badge variant="outline" className="text-[10px] bg-green-50 text-green-700 border-green-200">
										{sp.product_name}{sp.price && ` (${sp.price})`}
									</Badge>
								)}
							</span>
						))}
					</div>
				</div>
			)}

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

			{hasEvidence && (
				<div className="mt-3 border-t border-gray-100 pt-2">
					<button
						type="button"
						onClick={() => setShowEvidence(!showEvidence)}
						className="flex items-center gap-1 text-[11px] text-blue-500 hover:text-blue-700 transition-colors"
					>
						{showEvidence ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
						{showEvidence ? t("distribution.hideEvidence") : t("distribution.showEvidence")}
						<span className="text-gray-400">({ch.evidence_sources!.length} {t("distribution.evidenceCount")})</span>
					</button>
					{showEvidence && (
						<div className="mt-2 space-y-2">
							{ch.evidence_sources!.map((ev, i) => (
								<div key={i} className="text-[11px] bg-blue-50/50 rounded-lg p-2">
									<a href={ev.url} target="_blank" rel="noopener noreferrer" className="font-medium text-blue-600 hover:underline flex items-center gap-1">
										{ev.title}
										<ExternalLink size={9} />
									</a>
									<p className="text-gray-500 mt-0.5 leading-relaxed">{ev.snippet}</p>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

const GROUP_ORDER = ["tvShopping", "ec", "sns", "media", "other"];

const GROUP_ICONS: Record<string, typeof Tv> = {
	tvShopping: Tv,
	ec: ShoppingCart,
	sns: Share2,
	media: Newspaper,
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
										{t(`distribution.${groupKey}` as "distribution.tvShopping" | "distribution.ec" | "distribution.sns" | "distribution.media" | "distribution.other")}
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
