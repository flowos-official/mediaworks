'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Store, ChevronDown, ChevronUp, Target } from 'lucide-react';
import type { ChannelStrategyOutput } from '@/lib/md-strategy';
import SourcesCited from './SourcesCited';

interface Props {
	data: ChannelStrategyOutput;
}

function priorityColor(p: string): string {
	switch (p) {
		case 'immediate': return 'bg-green-100 text-green-800 border-green-300';
		case '3month': return 'bg-blue-100 text-blue-800 border-blue-300';
		case '6month': return 'bg-yellow-100 text-yellow-800 border-yellow-300';
		case '12month': return 'bg-gray-100 text-gray-600 border-gray-300';
		default: return 'bg-gray-100 text-gray-600 border-gray-300';
	}
}

function priorityLabel(p: string): string {
	switch (p) {
		case 'immediate': return '即時開始';
		case '3month': return '3ヶ月以内';
		case '6month': return '6ヶ月以内';
		case '12month': return '12ヶ月以内';
		default: return p;
	}
}

function scoreColor(score: number): string {
	if (score >= 80) return 'text-green-700 bg-green-50';
	if (score >= 60) return 'text-blue-700 bg-blue-50';
	if (score >= 40) return 'text-yellow-700 bg-yellow-50';
	return 'text-red-700 bg-red-50';
}

export default function ChannelStrategySection({ data }: Props) {
	const [expandedChannel, setExpandedChannel] = useState<string | null>(null);

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Store size={18} className="text-purple-600" />
				<h3 className="text-lg font-bold text-gray-900">チャネル戦略</h3>
			</div>

			{/* Launch sequence */}
			{data.launch_sequence.length > 0 && (
				<Card className="border-purple-200 bg-purple-50/20">
					<CardContent className="p-4">
						<span className="text-[10px] font-semibold text-purple-600 uppercase tracking-wide">展開ロードマップ</span>
						<div className="mt-2 space-y-2">
							{data.launch_sequence.map((phase, i) => (
								<div key={i} className="flex items-start gap-3">
									<div className="bg-purple-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-[10px] shrink-0 mt-0.5">
										{i + 1}
									</div>
									<div>
										<div className="flex items-center gap-2">
											<span className="text-sm font-semibold text-gray-900">{phase.phase}</span>
											<span className="text-[10px] px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full">{phase.timeline}</span>
										</div>
										<div className="flex flex-wrap gap-1 mt-1">
											{phase.channels.map((ch) => (
												<Badge key={ch} variant="secondary" className="text-[10px]">{ch}</Badge>
											))}
										</div>
										<p className="text-xs text-gray-500 mt-1">{phase.rationale}</p>
									</div>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Channel cards */}
			{data.channels
				.sort((a, b) => b.fit_score - a.fit_score)
				.map((ch) => {
					const isExpanded = expandedChannel === ch.name;
					return (
						<Card key={ch.name} className="border-gray-200">
							{/* Channel header — clickable */}
							<CardHeader
								className="pb-2 cursor-pointer hover:bg-gray-50/50 transition-colors"
								onClick={() => setExpandedChannel(isExpanded ? null : ch.name)}
							>
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-3">
										<CardTitle className="text-base font-bold">{ch.name}</CardTitle>
										<span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${priorityColor(ch.priority)}`}>
											{priorityLabel(ch.priority)}
										</span>
									</div>
									<div className="flex items-center gap-2">
										<span className={`text-sm font-bold px-3 py-1 rounded-full ${scoreColor(ch.fit_score)}`}>
											{ch.fit_score}
										</span>
										{isExpanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
									</div>
								</div>
								<span className="text-xs text-gray-500">{ch.market_size}</span>
							</CardHeader>

							{/* Expanded details */}
							{isExpanded && (
								<CardContent className="pt-0 space-y-4">
									{/* Entry Requirements */}
									<DetailBlock title="参入要件">
										<div className="grid grid-cols-2 gap-2 text-xs">
											<div><span className="text-gray-500">アカウント種別:</span> <span className="font-medium">{ch.entry_requirements.account_type}</span></div>
											<div><span className="text-gray-500">セットアップ期間:</span> <span className="font-medium">{ch.entry_requirements.setup_timeline}</span></div>
										</div>
										{ch.entry_requirements.required_documents.length > 0 && (
											<div className="mt-2">
												<span className="text-[10px] text-gray-500">必要書類:</span>
												<ul className="mt-0.5 space-y-0.5">
													{ch.entry_requirements.required_documents.map((doc, i) => (
														<li key={i} className="text-xs text-gray-700">• {doc}</li>
													))}
												</ul>
											</div>
										)}
										{ch.entry_requirements.initial_costs.length > 0 && (
											<div className="mt-2">
												<span className="text-[10px] text-gray-500">初期費用:</span>
												<div className="mt-0.5 space-y-0.5">
													{ch.entry_requirements.initial_costs.map((c, i) => (
														<div key={i} className="flex justify-between text-xs">
															<span className="text-gray-700">{c.item}</span>
															<span className="font-mono font-medium">{c.cost}</span>
														</div>
													))}
												</div>
											</div>
										)}
									</DetailBlock>

									{/* Fee Structure */}
									<DetailBlock title="手数料構造">
										<div className="grid grid-cols-2 gap-2 text-xs">
											<div><span className="text-gray-500">販売手数料:</span> <span className="font-medium font-mono">{ch.fee_structure.commission_rate}</span></div>
											<div><span className="text-gray-500">月額費用:</span> <span className="font-medium font-mono">{ch.fee_structure.monthly_fee}</span></div>
											<div><span className="text-gray-500">最低広告額:</span> <span className="font-medium font-mono">{ch.fee_structure.advertising_minimum}</span></div>
										</div>
										{ch.fee_structure.fulfillment_options.length > 0 && (
											<div className="flex flex-wrap gap-1 mt-2">
												{ch.fee_structure.fulfillment_options.map((opt) => (
													<Badge key={opt} variant="outline" className="text-[9px]">{opt}</Badge>
												))}
											</div>
										)}
									</DetailBlock>

									{/* Competitive Landscape */}
									<DetailBlock title="競合環境">
										<div className="text-xs space-y-1">
											<div><span className="text-gray-500">競合数:</span> {ch.competitive_landscape.competitor_count}</div>
											<div><span className="text-gray-500">価格帯:</span> {ch.competitive_landscape.price_range}</div>
											<div><span className="text-gray-500">主要プレーヤー:</span> {ch.competitive_landscape.dominant_players.join(', ')}</div>
											<div className="mt-1 bg-amber-50 px-2 py-1.5 rounded border border-amber-100">
												<span className="text-[10px] font-semibold text-amber-700">差別化機会:</span>
												<p className="text-gray-700 mt-0.5">{ch.competitive_landscape.differentiation_opportunity}</p>
											</div>
										</div>
									</DetailBlock>

									{/* Operations */}
									<DetailBlock title="運営体制">
										<div className="text-xs space-y-1">
											<div><span className="text-gray-500">在庫モデル:</span> {ch.operations_requirements.inventory_model}</div>
											<div><span className="text-gray-500">CS体制:</span> {ch.operations_requirements.cs_requirements}</div>
											<div><span className="text-gray-500">更新頻度:</span> {ch.operations_requirements.update_frequency}</div>
											{ch.operations_requirements.content_requirements.length > 0 && (
												<div>
													<span className="text-gray-500">コンテンツ要件:</span>
													<ul className="mt-0.5 space-y-0.5">
														{ch.operations_requirements.content_requirements.map((r, i) => (
															<li key={i} className="text-gray-700">• {r}</li>
														))}
													</ul>
												</div>
											)}
										</div>
									</DetailBlock>

									{/* KPIs */}
									{ch.kpis.length > 0 && (
										<DetailBlock title="目標KPI">
											<div className="space-y-1.5">
												{ch.kpis.map((kpi, i) => (
													<div key={i} className="flex items-center gap-2 text-xs">
														<Target size={10} className="text-indigo-500 shrink-0" />
														<span className="text-gray-700 font-medium">{kpi.metric}:</span>
														<span className="font-mono text-indigo-700">{kpi.target}</span>
														<span className="text-gray-400">({kpi.timeline})</span>
													</div>
												))}
											</div>
										</DetailBlock>
									)}
								</CardContent>
							)}
						</Card>
					);
				})}
			<SourcesCited sources={data.sources_cited} />
		</div>
	);
}

function DetailBlock({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="border-t border-gray-100 pt-3">
			<span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">{title}</span>
			{children}
		</div>
	);
}
