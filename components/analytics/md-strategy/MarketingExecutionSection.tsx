'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Megaphone, Calendar, Users } from 'lucide-react';
import type { MarketingExecutionOutput } from '@/lib/md-strategy';

interface Props {
	data: MarketingExecutionOutput;
}

function formatBudget(v: number): string {
	if (v >= 10_000_000) return `¥${(v / 10_000_000).toFixed(1)}千万`;
	if (v >= 10_000) return `¥${Math.round(v / 10_000)}万`;
	return `¥${v.toLocaleString()}`;
}

function tierColor(tier: string): string {
	switch (tier) {
		case 'mega': return 'bg-purple-100 text-purple-800';
		case 'macro': return 'bg-blue-100 text-blue-800';
		case 'micro': return 'bg-green-100 text-green-800';
		default: return 'bg-gray-100 text-gray-800';
	}
}

export default function MarketingExecutionSection({ data }: Props) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Megaphone size={18} className="text-orange-600" />
				<h3 className="text-lg font-bold text-gray-900">マーケティング実行計画</h3>
			</div>

			{/* Budget summary */}
			<Card className="border-orange-200 bg-orange-50/20">
				<CardContent className="p-4">
					<span className="text-[10px] font-semibold text-orange-600 uppercase tracking-wide">6ヶ月間予算サマリー</span>
					<div className="mt-2 flex items-baseline gap-2">
						<span className="text-2xl font-bold text-gray-900">{formatBudget(data.budget_summary.total_6month)}</span>
						<span className="text-xs text-gray-500">総予算</span>
					</div>

					{/* By channel */}
					{Object.keys(data.budget_summary.by_channel).length > 0 && (
						<div className="mt-3">
							<span className="text-[10px] text-gray-500 block mb-1">チャネル別</span>
							<div className="flex flex-wrap gap-1.5">
								{Object.entries(data.budget_summary.by_channel)
									.sort(([, a], [, b]) => b - a)
									.map(([ch, amt]) => (
										<span key={ch} className="text-[10px] px-2 py-0.5 bg-white border border-orange-200 rounded-full">
											{ch}: <span className="font-mono font-medium">{formatBudget(amt)}</span>
										</span>
									))}
							</div>
						</div>
					)}

					{/* By type */}
					{Object.keys(data.budget_summary.by_type).length > 0 && (
						<div className="mt-2">
							<span className="text-[10px] text-gray-500 block mb-1">施策別</span>
							<div className="flex flex-wrap gap-1.5">
								{Object.entries(data.budget_summary.by_type)
									.sort(([, a], [, b]) => b - a)
									.map(([type, amt]) => (
										<span key={type} className="text-[10px] px-2 py-0.5 bg-white border border-gray-200 rounded-full">
											{type}: <span className="font-mono font-medium">{formatBudget(amt)}</span>
										</span>
									))}
							</div>
						</div>
					)}
				</CardContent>
			</Card>

			{/* Monthly plans */}
			{data.monthly_plans.length > 0 && (
				<Card className="border-gray-200">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold flex items-center gap-1.5">
							<Calendar size={14} /> 月別実行計画
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						{data.monthly_plans.map((mp) => (
							<div key={mp.month} className="border border-gray-100 rounded-lg p-3">
								<div className="flex items-center justify-between mb-2">
									<span className="font-semibold text-sm text-gray-900">{mp.month}</span>
									<span className="text-xs font-mono text-orange-700 bg-orange-50 px-2 py-0.5 rounded">
										{formatBudget(mp.total_budget)}
									</span>
								</div>
								<div className="space-y-1.5">
									{mp.activities.map((act, i) => (
										<div key={i} className="flex items-start gap-2 text-xs">
											<Badge variant="outline" className="text-[9px] shrink-0">{act.channel}</Badge>
											<div className="flex-1">
												<span className="text-gray-800 font-medium">{act.activity}</span>
												<div className="flex gap-3 mt-0.5 text-gray-500">
													<span>予算: <span className="font-mono">{formatBudget(act.budget)}</span></span>
													{act.expected_impressions && <span>IMP: {act.expected_impressions}</span>}
													{act.expected_conversions && <span>CV: {act.expected_conversions}</span>}
												</div>
											</div>
										</div>
									))}
								</div>
							</div>
						))}
					</CardContent>
				</Card>
			)}

			{/* Content calendar */}
			{data.content_calendar.length > 0 && (
				<Card className="border-gray-200">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold">コンテンツカレンダー（8週間）</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="overflow-x-auto">
							<table className="w-full text-xs">
								<thead>
									<tr className="border-b border-gray-200 text-gray-500">
										<th className="text-left px-2 py-1.5">週</th>
										<th className="text-left px-2 py-1.5">チャネル</th>
										<th className="text-left px-2 py-1.5">種別</th>
										<th className="text-left px-2 py-1.5">テーマ</th>
										<th className="text-left px-2 py-1.5">商品</th>
									</tr>
								</thead>
								<tbody>
									{data.content_calendar.map((cc, i) => (
										<tr key={i} className="border-b border-gray-50">
											<td className="px-2 py-1.5 text-gray-500 font-mono">{cc.week}</td>
											<td className="px-2 py-1.5">{cc.channel}</td>
											<td className="px-2 py-1.5">
												<Badge variant="secondary" className="text-[9px]">{cc.content_type}</Badge>
											</td>
											<td className="px-2 py-1.5 text-gray-800">{cc.topic}</td>
											<td className="px-2 py-1.5 text-gray-600">{cc.product_focus}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Influencer plan */}
			{data.influencer_plan.length > 0 && (
				<Card className="border-gray-200">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold flex items-center gap-1.5">
							<Users size={14} /> インフルエンサー施策
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="space-y-2">
							{data.influencer_plan.map((ip, i) => (
								<div key={i} className="bg-gray-50 rounded-lg px-3 py-2.5">
									<div className="flex items-center gap-2 mb-1">
										<Badge className={`text-[10px] ${tierColor(ip.tier)}`}>{ip.tier}</Badge>
										<span className="text-sm font-medium text-gray-900">{ip.count}名</span>
										<span className="text-xs text-gray-500">@{ip.platform}</span>
									</div>
									<div className="grid grid-cols-2 gap-2 text-xs text-gray-600 mt-1">
										<div>予算/人: <span className="font-mono font-medium">{ip.budget_per_person}</span></div>
										<div>期待ROI: <span className="font-mono font-medium">{ip.expected_roi}</span></div>
									</div>
									<p className="text-[10px] text-gray-500 mt-1">{ip.selection_criteria}</p>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
