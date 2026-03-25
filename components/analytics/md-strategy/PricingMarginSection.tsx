'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DollarSign, TrendingUp } from 'lucide-react';
import type { PricingMarginOutput } from '@/lib/md-strategy';
import SourcesCited from './SourcesCited';

interface Props {
	data: PricingMarginOutput;
}

function marginColor(pct: number): string {
	if (pct >= 30) return 'text-green-700 bg-green-50';
	if (pct >= 15) return 'text-blue-700 bg-blue-50';
	if (pct >= 5) return 'text-yellow-700 bg-yellow-50';
	return 'text-red-700 bg-red-50';
}

export default function PricingMarginSection({ data }: Props) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<DollarSign size={18} className="text-emerald-600" />
				<h3 className="text-lg font-bold text-gray-900">価格・マージン戦略</h3>
			</div>

			{/* Product pricing table per product */}
			{data.product_pricing.map((pp) => (
				<Card key={pp.product_code} className="border-gray-200">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-bold">{pp.product_name}</CardTitle>
						<div className="flex gap-3 text-xs text-gray-500">
							{pp.cost_basis.cost_price > 0 && <span>原価: <span className="font-mono font-medium text-gray-700">¥{pp.cost_basis.cost_price.toLocaleString()}</span></span>}
							{pp.cost_basis.wholesale_rate > 0 && <span>卸売率: <span className="font-mono font-medium text-gray-700">{pp.cost_basis.wholesale_rate}%</span></span>}
							{pp.cost_basis.current_tv_price > 0 && <span>TV単価: <span className="font-mono font-medium text-gray-700">¥{pp.cost_basis.current_tv_price.toLocaleString()}</span></span>}
						</div>
					</CardHeader>
					<CardContent className="pt-0">
						<div className="overflow-x-auto">
							<table className="w-full text-xs">
								<thead>
									<tr className="border-b border-gray-200 text-gray-500">
										<th className="text-left px-2 py-1.5">チャネル</th>
										<th className="text-right px-2 py-1.5">推奨価格</th>
										<th className="text-right px-2 py-1.5">競合基準</th>
										<th className="text-right px-2 py-1.5">手数料</th>
										<th className="text-right px-2 py-1.5">純粗利率</th>
										<th className="text-right px-2 py-1.5">純粗利額</th>
									</tr>
								</thead>
								<tbody>
									{pp.channel_pricing.map((cp) => (
										<tr key={cp.channel} className="border-b border-gray-50 hover:bg-gray-50/50">
											<td className="px-2 py-2 font-medium text-gray-800">{cp.channel}</td>
											<td className="px-2 py-2 text-right font-mono font-medium">¥{cp.recommended_price.toLocaleString()}</td>
											<td className="px-2 py-2 text-right text-gray-500">{cp.competitor_benchmark}</td>
											<td className="px-2 py-2 text-right text-gray-500">{cp.channel_fees}</td>
											<td className="px-2 py-2 text-right">
												<span className={`font-mono font-medium px-1.5 py-0.5 rounded ${marginColor(cp.net_margin_pct)}`}>
													{cp.net_margin_pct}%
												</span>
											</td>
											<td className="px-2 py-2 text-right font-mono">¥{cp.net_margin_yen.toLocaleString()}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{/* Reasoning for first channel */}
						{pp.channel_pricing[0]?.reasoning && (
							<p className="text-[10px] text-gray-500 mt-2 italic">{pp.channel_pricing[0].reasoning}</p>
						)}
					</CardContent>
				</Card>
			))}

			{/* BEP Analysis */}
			{data.bep_analysis.length > 0 && (
				<Card className="border-emerald-200 bg-emerald-50/20">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold flex items-center gap-1.5 text-emerald-700">
							<TrendingUp size={14} /> 損益分岐点（BEP）分析
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						{data.bep_analysis.map((bep) => (
							<div key={bep.channel} className="bg-white rounded-lg border border-emerald-100 p-3">
								<div className="flex items-center justify-between mb-2">
									<span className="font-semibold text-sm text-gray-900">{bep.channel}</span>
									<Badge className="bg-emerald-600 text-white text-[10px]">BEP: {bep.bep_units}個/月</Badge>
								</div>
								<div className="grid grid-cols-3 gap-2 text-xs mb-2">
									<div className="bg-gray-50 rounded px-2 py-1">
										<span className="text-gray-500 block text-[9px]">変動費/個</span>
										<span className="font-mono font-medium">¥{bep.variable_cost_per_unit.toLocaleString()}</span>
									</div>
									<div className="bg-gray-50 rounded px-2 py-1">
										<span className="text-gray-500 block text-[9px]">BEP売上</span>
										<span className="font-mono font-medium">¥{bep.bep_revenue.toLocaleString()}</span>
									</div>
									<div className="bg-gray-50 rounded px-2 py-1">
										<span className="text-gray-500 block text-[9px]">達成見込</span>
										<span className="font-medium">{bep.bep_timeline}</span>
									</div>
								</div>
								{bep.fixed_costs.length > 0 && (
									<div className="text-[10px] text-gray-500">
										固定費: {bep.fixed_costs.map((fc) => `${fc.item} ¥${fc.monthly.toLocaleString()}/月`).join(' + ')}
									</div>
								)}
							</div>
						))}
					</CardContent>
				</Card>
			)}

			{/* Margin optimization tips */}
			{data.margin_optimization.length > 0 && (
				<Card className="border-gray-200">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold">マージン改善提案</CardTitle>
					</CardHeader>
					<CardContent>
						<ul className="space-y-1">
							{data.margin_optimization.map((tip, i) => (
								<li key={i} className="text-xs text-gray-700 flex gap-2">
									<span className="text-emerald-500 shrink-0">●</span>
									{tip}
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			)}
			<SourcesCited sources={data.sources_cited} />
		</div>
	);
}
