'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Package, TrendingUp, TrendingDown, Minus, ShieldX } from 'lucide-react';
import type { ProductSelectionOutput } from '@/lib/md-strategy';

interface Props {
	data: ProductSelectionOutput;
}

function TrajectoryIcon({ trajectory }: { trajectory: string }) {
	switch (trajectory) {
		case 'growing':
			return <TrendingUp size={12} className="text-green-600" />;
		case 'declining':
			return <TrendingDown size={12} className="text-red-500" />;
		default:
			return <Minus size={12} className="text-gray-400" />;
	}
}

function trajectoryLabel(t: string): string {
	switch (t) {
		case 'growing': return '上昇';
		case 'declining': return '下降';
		default: return '安定';
	}
}

function trajectoryColor(t: string): string {
	switch (t) {
		case 'growing': return 'bg-green-50 text-green-700 border-green-200';
		case 'declining': return 'bg-red-50 text-red-700 border-red-200';
		default: return 'bg-gray-50 text-gray-600 border-gray-200';
	}
}

export default function ProductSelectionSection({ data }: Props) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Package size={18} className="text-blue-600" />
				<h3 className="text-lg font-bold text-gray-900">商品選定</h3>
			</div>

			{/* Portfolio strategy summary */}
			<Card className="border-blue-200 bg-blue-50/30">
				<CardContent className="p-4">
					<span className="text-[10px] font-semibold text-blue-600 uppercase tracking-wide">ポートフォリオ戦略</span>
					<p className="text-sm text-gray-700 leading-relaxed mt-1 whitespace-pre-line">{data.portfolio_strategy}</p>
				</CardContent>
			</Card>

			{/* Channel-product matrix */}
			{data.channel_product_matrix.map((ch) => (
				<Card key={ch.channel} className="border-gray-200">
					<CardHeader className="pb-2">
						<CardTitle className="text-base font-bold">{ch.channel}</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4 pt-0">
						{/* Tier 1 */}
						{ch.tier1_products.length > 0 && (
							<div>
								<div className="flex items-center gap-2 mb-2">
									<Badge className="bg-blue-600 text-white text-[10px]">Tier 1 — 即時投入</Badge>
								</div>
								<div className="space-y-2">
									{ch.tier1_products.map((p) => (
										<div key={p.code} className="bg-white border border-blue-100 rounded-lg px-3 py-2.5">
											<div className="flex items-center justify-between mb-1">
												<span className="font-semibold text-sm text-gray-900">{p.name}</span>
												<div className="flex items-center gap-1.5">
													<span className={`text-[10px] px-2 py-0.5 rounded-full border flex items-center gap-1 ${trajectoryColor(p.monthly_trajectory)}`}>
														<TrajectoryIcon trajectory={p.monthly_trajectory} />
														{trajectoryLabel(p.monthly_trajectory)}
													</span>
												</div>
											</div>
											<p className="text-xs text-gray-600 leading-relaxed">{p.reason}</p>
											{p.margin_headroom && (
												<p className="text-xs text-emerald-700 mt-1 bg-emerald-50 px-2 py-1 rounded">
													{p.margin_headroom}
												</p>
											)}
										</div>
									))}
								</div>
							</div>
						)}

						{/* Tier 2 */}
						{ch.tier2_products.length > 0 && (
							<div>
								<div className="flex items-center gap-2 mb-2">
									<Badge variant="secondary" className="text-[10px]">Tier 2 — 第2弾</Badge>
								</div>
								<div className="space-y-1.5">
									{ch.tier2_products.map((p) => (
										<div key={p.code} className="bg-gray-50 rounded-lg px-3 py-2">
											<span className="font-medium text-sm text-gray-800">{p.name}</span>
											<p className="text-xs text-gray-500 mt-0.5">{p.reason}</p>
										</div>
									))}
								</div>
							</div>
						)}

						{/* Exclusions */}
						{ch.exclusions.length > 0 && (
							<div>
								<div className="flex items-center gap-1.5 mb-1.5">
									<ShieldX size={12} className="text-red-400" />
									<span className="text-[10px] font-semibold text-red-500 uppercase">不適合商品</span>
								</div>
								<div className="space-y-1">
									{ch.exclusions.map((p) => (
										<div key={p.code} className="flex items-start gap-2 text-xs text-gray-500">
											<span className="text-red-400">-</span>
											<span><span className="text-gray-700">{p.name}</span>: {p.reason}</span>
										</div>
									))}
								</div>
							</div>
						)}
					</CardContent>
				</Card>
			))}
		</div>
	);
}
