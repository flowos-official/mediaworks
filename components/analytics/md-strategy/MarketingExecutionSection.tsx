'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Megaphone, Calendar, Users } from 'lucide-react';
import type { MarketingExecutionOutput } from '@/lib/md-strategy';
import SourcesCited from './SourcesCited';

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
		case 'mega': return 'bg-purple-600/15 text-purple-800 dark:text-purple-200';
		case 'macro': return 'bg-blue-600/15 text-blue-800 dark:text-blue-200';
		case 'micro': return 'bg-green-600/15 text-green-800 dark:text-green-200';
		default: return 'bg-muted text-foreground';
	}
}

export default function MarketingExecutionSection({ data }: Props) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Megaphone size={18} className="text-orange-600" />
				<h3 className="text-lg font-bold text-foreground">マーケティング実行計画</h3>
			</div>

			{/* Budget summary */}
			{data.budget_summary && (
			<Card className="border-orange-600/30 bg-orange-600/5">
				<CardContent className="p-4">
					<span className="text-[10px] font-semibold text-orange-600 dark:text-orange-300 uppercase tracking-wide">6ヶ月間予算サマリー</span>
					<div className="mt-2 flex items-baseline gap-2">
						<span className="text-2xl font-bold text-foreground">{formatBudget(data.budget_summary.total_6month)}</span>
						<span className="text-xs text-muted-foreground">総予算</span>
					</div>

					{/* By channel */}
					{Object.keys(data.budget_summary.by_channel ?? {}).length > 0 && (
						<div className="mt-3">
							<span className="text-[10px] text-muted-foreground block mb-1">チャネル別</span>
							<div className="flex flex-wrap gap-1.5">
								{Object.entries(data.budget_summary.by_channel ?? {})
									.sort(([, a], [, b]) => b - a)
									.map(([ch, amt]) => (
										<span key={ch} className="text-[10px] px-2 py-0.5 bg-card border border-orange-600/30 rounded-full">
											{ch}: <span className="font-mono font-medium">{formatBudget(amt)}</span>
										</span>
									))}
							</div>
						</div>
					)}

					{/* By type */}
					{Object.keys(data.budget_summary.by_type ?? {}).length > 0 && (
						<div className="mt-2">
							<span className="text-[10px] text-muted-foreground block mb-1">施策別</span>
							<div className="flex flex-wrap gap-1.5">
								{Object.entries(data.budget_summary.by_type ?? {})
									.sort(([, a], [, b]) => b - a)
									.map(([type, amt]) => (
										<span key={type} className="text-[10px] px-2 py-0.5 bg-card border border-border rounded-full">
											{type}: <span className="font-mono font-medium">{formatBudget(amt)}</span>
										</span>
									))}
							</div>
						</div>
					)}
				</CardContent>
			</Card>
			)}

			{/* Monthly plans */}
			{(data.monthly_plans ?? []).length > 0 && (
				<Card className="border-border">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold flex items-center gap-1.5">
							<Calendar size={14} /> 月別実行計画
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						{(data.monthly_plans ?? []).map((mp) => (
							<div key={mp.month} className="border border-border rounded-lg p-3">
								<div className="flex items-center justify-between mb-2">
									<span className="font-semibold text-sm text-foreground">{mp.month}</span>
									<span className="text-xs font-mono text-orange-700 dark:text-orange-300 bg-orange-600/10 px-2 py-0.5 rounded">
										{formatBudget(mp.total_budget)}
									</span>
								</div>
								<div className="space-y-1.5">
									{(mp.activities ?? []).map((act, i) => (
										<div key={i} className="flex items-start gap-2 text-xs">
											<Badge variant="outline" className="text-[9px] shrink-0">{act.channel}</Badge>
											<div className="flex-1">
												<span className="text-foreground font-medium">{act.activity}</span>
												<div className="flex gap-3 mt-0.5 text-muted-foreground">
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
			{(data.content_calendar ?? []).length > 0 && (
				<Card className="border-border">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold">コンテンツカレンダー（8週間）</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="overflow-x-auto">
							<table className="w-full text-xs">
								<thead>
									<tr className="border-b border-border text-muted-foreground">
										<th className="text-left px-2 py-1.5">週</th>
										<th className="text-left px-2 py-1.5">チャネル</th>
										<th className="text-left px-2 py-1.5">種別</th>
										<th className="text-left px-2 py-1.5">テーマ</th>
										<th className="text-left px-2 py-1.5">商品</th>
									</tr>
								</thead>
								<tbody>
									{(data.content_calendar ?? []).map((cc, i) => (
										<tr key={i} className="border-b border-border">
											<td className="px-2 py-1.5 text-muted-foreground font-mono">{cc.week}</td>
											<td className="px-2 py-1.5">{cc.channel}</td>
											<td className="px-2 py-1.5">
												<Badge variant="secondary" className="text-[9px]">{cc.content_type}</Badge>
											</td>
											<td className="px-2 py-1.5 text-foreground">{cc.topic}</td>
											<td className="px-2 py-1.5 text-muted-foreground">{cc.product_focus}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Influencer plan */}
			{(data.influencer_plan ?? []).length > 0 && (
				<Card className="border-border">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold flex items-center gap-1.5">
							<Users size={14} /> インフルエンサー施策
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="space-y-2">
							{(data.influencer_plan ?? []).map((ip, i) => (
								<div key={i} className="bg-muted rounded-lg px-3 py-2.5">
									<div className="flex items-center gap-2 mb-1">
										<Badge className={`text-[10px] ${tierColor(ip.tier)}`}>{ip.tier}</Badge>
										<span className="text-sm font-medium text-foreground">{ip.count}名</span>
										<span className="text-xs text-muted-foreground">@{ip.platform}</span>
									</div>
									<div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground mt-1">
										<div>予算/人: <span className="font-mono font-medium">{ip.budget_per_person}</span></div>
										<div>期待ROI: <span className="font-mono font-medium">{ip.expected_roi}</span></div>
									</div>
									<p className="text-[10px] text-muted-foreground mt-1">{ip.selection_criteria}</p>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}
			<SourcesCited sources={data.sources_cited} />
		</div>
	);
}
