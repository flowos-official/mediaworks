'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BarChart3, TrendingUp } from 'lucide-react';
import {
	AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
	BarChart, Bar, Legend,
} from 'recharts';
import type { FinancialProjectionOutput } from '@/lib/md-strategy';
import SourcesCited from './SourcesCited';

interface Props {
	data: FinancialProjectionOutput;
}

function formatYen(v: number | null | undefined): string {
	if (v == null || typeof v !== "number" || !Number.isFinite(v)) return "¥—";
	if (v >= 100_000_000) return `¥${(v / 100_000_000).toFixed(1)}億`;
	if (v >= 10_000) return `¥${Math.round(v / 10_000)}万`;
	return `¥${v.toLocaleString()}`;
}

function roiColor(pct: number): string {
	if (pct >= 100) return 'text-green-700 bg-green-50';
	if (pct >= 50) return 'text-blue-700 bg-blue-50';
	if (pct >= 0) return 'text-yellow-700 bg-yellow-50';
	return 'text-red-700 bg-red-50';
}

export default function FinancialProjectionSection({ data }: Props) {
	// Prepare chart data
	const monthlyForecast = data.monthly_forecast ?? [];
	const chartData = monthlyForecast.map((mf) => ({
		month: mf.month.replace('2026年', '').replace('2027年', "'27 "),
		revenue: Math.round(mf.total_revenue / 10000),
		profit: Math.round(mf.total_profit / 10000),
	}));

	// Channel breakdown for stacked chart
	const allChannels = new Set<string>();
	for (const mf of monthlyForecast) {
		for (const ch of (mf.by_channel ?? [])) allChannels.add(ch.channel);
	}
	const channelColors = ['#3b82f6', '#8b5cf6', '#f59e0b', '#10b981', '#ef4444', '#ec4899', '#06b6d4'];

	const stackedData = monthlyForecast.map((mf) => {
		const row: Record<string, string | number> = { month: mf.month.replace('2026年', '').replace('2027年', "'27 ") };
		for (const ch of (mf.by_channel ?? [])) {
			row[ch.channel] = Math.round(ch.revenue / 10000);
		}
		return row;
	});

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<BarChart3 size={18} className="text-blue-600" />
				<h3 className="text-lg font-bold text-gray-900">収益予測</h3>
			</div>

			{/* Total revenue/profit trend chart */}
			{chartData.length > 0 && (
				<Card className="border-gray-200">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold">12ヶ月売上・利益推移 (万円)</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="h-56">
							<ResponsiveContainer width="100%" height="100%">
								<AreaChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
									<CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
									<XAxis dataKey="month" tick={{ fontSize: 10, fill: '#9ca3af' }} />
									<YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} tickFormatter={(v) => `${v}万`} />
									<Tooltip formatter={(v: unknown) => [`${Number(v)}万円`]} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
									<Area type="monotone" dataKey="revenue" name="売上" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.15} strokeWidth={2} />
									<Area type="monotone" dataKey="profit" name="利益" stroke="#10b981" fill="#10b981" fillOpacity={0.15} strokeWidth={2} />
								</AreaChart>
							</ResponsiveContainer>
						</div>
					</CardContent>
				</Card>
			)}

			{/* Channel breakdown stacked bar */}
			{stackedData.length > 0 && allChannels.size > 0 && (
				<Card className="border-gray-200">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold">チャネル別売上構成 (万円)</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="h-56">
							<ResponsiveContainer width="100%" height="100%">
								<BarChart data={stackedData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
									<CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
									<XAxis dataKey="month" tick={{ fontSize: 10, fill: '#9ca3af' }} />
									<YAxis tick={{ fontSize: 10, fill: '#9ca3af' }} tickFormatter={(v) => `${v}万`} />
									<Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} />
									<Legend wrapperStyle={{ fontSize: 10 }} />
									{[...allChannels].map((ch, i) => (
										<Bar key={ch} dataKey={ch} stackId="a" fill={channelColors[i % channelColors.length]} radius={i === allChannels.size - 1 ? [4, 4, 0, 0] : undefined} />
									))}
								</BarChart>
							</ResponsiveContainer>
						</div>
					</CardContent>
				</Card>
			)}

			{/* ROI Timeline */}
			{(data.roi_timeline ?? []).length > 0 && (
				<Card className="border-gray-200">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold flex items-center gap-1.5">
							<TrendingUp size={14} /> ROIタイムライン
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="space-y-2">
							{(data.roi_timeline ?? [])
								.sort((a, b) => b.year1_roi_pct - a.year1_roi_pct)
								.map((roi) => (
									<div key={roi.channel} className="bg-gray-50 rounded-lg px-3 py-2.5">
										<div className="flex items-center justify-between mb-1">
											<span className="font-semibold text-sm text-gray-900">{roi.channel}</span>
											<span className={`font-mono font-bold px-2 py-0.5 rounded text-sm ${roiColor(roi.year1_roi_pct)}`}>
												ROI {roi.year1_roi_pct}%
											</span>
										</div>
										<div className="grid grid-cols-3 gap-2 text-xs">
											<div>
												<span className="text-gray-500 block text-[9px]">総投資額</span>
												<span className="font-mono font-medium">{formatYen(roi.total_investment)}</span>
											</div>
											<div>
												<span className="text-gray-500 block text-[9px]">損益分岐</span>
												<span className="font-medium">{roi.breakeven_month}</span>
											</div>
											<div>
												<span className="text-gray-500 block text-[9px]">1年目純利益</span>
												<span className="font-mono font-medium">{formatYen(roi.year1_net_profit)}</span>
											</div>
										</div>
									</div>
								))}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Scenarios */}
			{data.scenarios && (
			<Card className="border-blue-200 bg-blue-50/20">
				<CardHeader className="pb-2">
					<CardTitle className="text-sm font-semibold text-blue-700">シナリオ分析</CardTitle>
				</CardHeader>
				<CardContent>
					<div className="grid grid-cols-3 gap-3 mb-3">
						{[
							{ label: '保守的', data: data.scenarios.conservative, color: 'border-gray-300 bg-gray-50' },
							{ label: '中立的', data: data.scenarios.moderate, color: 'border-blue-300 bg-blue-50' },
							{ label: '積極的', data: data.scenarios.aggressive, color: 'border-green-300 bg-green-50' },
						].filter((s) => s.data).map((s) => (
							<div key={s.label} className={`rounded-lg border p-3 text-center ${s.color}`}>
								<span className="text-[10px] font-semibold text-gray-500 uppercase">{s.label}</span>
								<div className="mt-1">
									<div className="text-lg font-bold text-gray-900">{formatYen(s.data.year1_revenue)}</div>
									<div className="text-xs text-gray-500">売上</div>
								</div>
								<div className="mt-1">
									<div className="text-sm font-semibold text-emerald-700">{formatYen(s.data.year1_profit)}</div>
									<div className="text-[10px] text-gray-500">利益</div>
								</div>
							</div>
						))}
					</div>
					{(data.scenarios.assumptions ?? []).length > 0 && (
						<div>
							<span className="text-[10px] text-gray-500 font-semibold">前提条件:</span>
							<ul className="mt-0.5 space-y-0.5">
								{(data.scenarios.assumptions ?? []).map((a, i) => (
									<li key={i} className="text-[10px] text-gray-600">• {a}</li>
								))}
							</ul>
						</div>
					)}
				</CardContent>
			</Card>
			)}
			<SourcesCited sources={data.sources_cited} />
		</div>
	);
}
