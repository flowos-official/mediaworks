"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Video, Lightbulb, MessageCircle, Target } from "lucide-react";

interface Platform {
	platform_name: string;
	platform_type: string;
	target_audience: string;
	fit_score: number;
	reason: string;
}

interface LiveCommerceData {
	platforms: Platform[];
	scripts: {
		instagram_live: string;
		tiktok_live: string;
		youtube_live: string;
	};
	talking_points: string[];
	engagement_tips: string[];
	recommended_products_angle: string;
}

function ScoreBar({ score }: { score: number }) {
	const color =
		score >= 80 ? "bg-green-500" :
		score >= 60 ? "bg-blue-500" :
		score >= 40 ? "bg-yellow-500" : "bg-red-400";

	return (
		<div className="flex items-center gap-2">
			<div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
				<div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${score}%` }} />
			</div>
			<span className="text-xs font-bold tabular-nums w-8 text-right">{score}</span>
		</div>
	);
}

const SCRIPT_TABS = [
	{ key: "instagram_live" as const, label: "instagramLive", color: "bg-gradient-to-r from-purple-500 to-pink-500" },
	{ key: "tiktok_live" as const, label: "tiktokLive", color: "bg-black" },
	{ key: "youtube_live" as const, label: "youtubeLive", color: "bg-red-600" },
];

export default function LiveCommerceSection({ data }: { data: LiveCommerceData }) {
	const t = useTranslations("report");
	const [activeScript, setActiveScript] = useState<"instagram_live" | "tiktok_live" | "youtube_live">("instagram_live");

	return (
		<div className="space-y-4">
			{/* Platform Fit Analysis */}
			<Card>
				<CardContent className="p-6">
					<div className="flex items-center gap-2 mb-5">
						<Video className="h-5 w-5 text-pink-500" />
						<h3 className="text-lg font-semibold text-gray-900">{t("liveCommerce.title")}</h3>
					</div>

					{/* Platforms */}
					<h4 className="text-sm font-semibold text-gray-700 mb-3">{t("liveCommerce.platforms")}</h4>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
						{data.platforms.map((p, i) => (
							<div key={p.platform_name || i} className="border border-gray-100 rounded-xl p-4 bg-gray-50/50">
								<div className="flex items-start justify-between mb-2">
									<h5 className="font-semibold text-sm">{p.platform_name}</h5>
									<Badge className="text-[10px] bg-pink-100 text-pink-800">{p.platform_type}</Badge>
								</div>
								<p className="text-xs text-gray-500 mb-2">{p.target_audience}</p>
								<ScoreBar score={p.fit_score} />
								<p className="text-xs text-gray-600 leading-relaxed mt-2">{p.reason}</p>
							</div>
						))}
					</div>

					{/* Product Angle */}
					{data.recommended_products_angle && (
						<div className="bg-pink-50 rounded-xl p-4 mb-6">
							<div className="flex items-center gap-2 mb-2">
								<Target size={14} className="text-pink-600" />
								<h4 className="text-sm font-semibold text-pink-800">{t("liveCommerce.productAngle")}</h4>
							</div>
							<p className="text-sm text-pink-900 leading-relaxed">{data.recommended_products_angle}</p>
						</div>
					)}

					{/* Talking Points */}
					{data.talking_points && data.talking_points.length > 0 && (
						<div className="mb-6">
							<div className="flex items-center gap-2 mb-3">
								<MessageCircle size={14} className="text-blue-600" />
								<h4 className="text-sm font-semibold text-gray-700">{t("liveCommerce.talkingPoints")}</h4>
							</div>
							<div className="space-y-2">
								{data.talking_points.map((point, i) => (
									<div key={i} className="flex items-start gap-2 text-sm text-gray-700">
										<span className="flex-shrink-0 w-5 h-5 bg-blue-100 text-blue-700 rounded-full text-xs flex items-center justify-center font-bold mt-0.5">
											{i + 1}
										</span>
										{point}
									</div>
								))}
							</div>
						</div>
					)}

					{/* Engagement Tips */}
					{data.engagement_tips && data.engagement_tips.length > 0 && (
						<div>
							<div className="flex items-center gap-2 mb-3">
								<Lightbulb size={14} className="text-yellow-600" />
								<h4 className="text-sm font-semibold text-gray-700">{t("liveCommerce.engagementTips")}</h4>
							</div>
							<div className="space-y-2">
								{data.engagement_tips.map((tip, i) => (
									<div key={i} className="flex items-start gap-2 text-sm text-gray-600 bg-yellow-50 rounded-lg p-3">
										<Lightbulb size={14} className="text-yellow-500 mt-0.5 flex-shrink-0" />
										{tip}
									</div>
								))}
							</div>
						</div>
					)}
				</CardContent>
			</Card>

			{/* Live Scripts */}
			<Card>
				<CardContent className="p-6">
					<h4 className="text-sm font-semibold text-gray-700 mb-4">{t("liveCommerce.scripts")}</h4>

					{/* Tab bar */}
					<div className="flex gap-2 mb-4">
						{SCRIPT_TABS.map((tab) => (
							<button
								key={tab.key}
								type="button"
								onClick={() => setActiveScript(tab.key)}
								className={`px-4 py-2 text-xs font-medium rounded-lg transition-all ${
									activeScript === tab.key
										? `${tab.color} text-white shadow-sm`
										: "bg-gray-100 text-gray-600 hover:bg-gray-200"
								}`}
							>
								{t(`liveCommerce.${tab.label}` as "liveCommerce.instagramLive" | "liveCommerce.tiktokLive" | "liveCommerce.youtubeLive")}
							</button>
						))}
					</div>

					{/* Script content */}
					<div className="bg-gray-50 rounded-xl p-5 border border-gray-100">
						<pre className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap font-sans">
							{data.scripts[activeScript]}
						</pre>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
