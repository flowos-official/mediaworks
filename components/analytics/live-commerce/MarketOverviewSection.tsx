'use client';

import { Card, CardContent } from '@/components/ui/card';
import { TrendingUp, Users, Globe, Lightbulb } from 'lucide-react';
import type { MarketResearchOutput } from '@/lib/live-commerce-strategy';

interface Props {
	data: MarketResearchOutput;
}

export default function MarketOverviewSection({ data }: Props) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Globe size={18} className="text-emerald-600" />
				<h3 className="text-lg font-bold text-gray-900">市場概況</h3>
			</div>

			{/* Key stats */}
			<div className="grid grid-cols-2 gap-3">
				<Card className="border-emerald-200 bg-emerald-50/30">
					<CardContent className="p-3 text-center">
						<div className="text-[10px] text-gray-500 uppercase font-semibold">市場規模</div>
						<div className="text-lg font-bold text-emerald-700 mt-1">{data.market_size}</div>
					</CardContent>
				</Card>
				<Card className="border-emerald-200 bg-emerald-50/30">
					<CardContent className="p-3 text-center">
						<div className="text-[10px] text-gray-500 uppercase font-semibold">成長率</div>
						<div className="text-lg font-bold text-emerald-700 mt-1">{data.growth_rate}</div>
					</CardContent>
				</Card>
			</div>

			{/* Consumer behavior */}
			<Card className="border-gray-200">
				<CardContent className="p-4">
					<div className="flex items-center gap-1.5 mb-2">
						<Users size={14} className="text-blue-600" />
						<span className="text-xs font-semibold text-gray-600">消費者行動</span>
					</div>
					<p className="text-sm text-gray-700 leading-relaxed">{data.consumer_behavior}</p>
				</CardContent>
			</Card>

			{/* Key trends */}
			<Card className="border-gray-200">
				<CardContent className="p-4">
					<div className="flex items-center gap-1.5 mb-3">
						<TrendingUp size={14} className="text-orange-600" />
						<span className="text-xs font-semibold text-gray-600">主要トレンド</span>
					</div>
					<div className="space-y-2">
						{(data.key_trends ?? []).map((t, i) => (
							<div key={i} className="flex items-start gap-2">
								<span className="bg-orange-100 text-orange-700 rounded-full w-5 h-5 flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">{i + 1}</span>
								<div>
									<span className="text-sm font-medium text-gray-800">{t.trend}</span>
									<p className="text-xs text-gray-500 mt-0.5">{t.description}</p>
								</div>
							</div>
						))}
					</div>
				</CardContent>
			</Card>

			{/* Major players */}
			<Card className="border-gray-200">
				<CardContent className="p-4">
					<div className="flex items-center gap-1.5 mb-3">
						<Lightbulb size={14} className="text-purple-600" />
						<span className="text-xs font-semibold text-gray-600">主要プレイヤー</span>
					</div>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-2">
						{(data.major_players ?? []).map((p, i) => (
							<div key={i} className="bg-gray-50 rounded-lg p-2.5 border border-gray-100">
								<div className="flex items-center gap-2 mb-1">
									<span className="text-sm font-medium text-gray-800">{p.name}</span>
									<span className="text-[9px] px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded">{p.platform}</span>
								</div>
								<p className="text-xs text-gray-500">{p.description}</p>
							</div>
						))}
					</div>
				</CardContent>
			</Card>

			{/* Market outlook */}
			<div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4">
				<span className="text-xs font-semibold text-emerald-700">市場見通し</span>
				<p className="text-sm text-gray-700 mt-1 leading-relaxed">{data.market_outlook}</p>
			</div>
		</div>
	);
}
