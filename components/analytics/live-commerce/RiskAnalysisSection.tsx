'use client';

import { Card, CardContent } from '@/components/ui/card';
import { ShieldAlert, CheckCircle } from 'lucide-react';
import type { RiskAnalysisOutput } from '@/lib/live-commerce-strategy';

interface Props {
	data: RiskAnalysisOutput;
}

function severityBadge(level: string): string {
	switch (level) {
		case 'high': return 'bg-red-100 text-red-700 border-red-200';
		case 'medium': return 'bg-yellow-100 text-yellow-700 border-yellow-200';
		case 'low': return 'bg-green-100 text-green-700 border-green-200';
		default: return 'bg-gray-100 text-gray-600 border-gray-200';
	}
}

function levelLabel(level: string): string {
	switch (level) {
		case 'high': return '高';
		case 'medium': return '中';
		case 'low': return '低';
		default: return level;
	}
}

export default function RiskAnalysisSection({ data }: Props) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<ShieldAlert size={18} className="text-red-600" />
				<h3 className="text-lg font-bold text-gray-900">リスク分析</h3>
			</div>

			{/* Risk cards */}
			<div className="space-y-2">
				{(data.risks ?? []).map((risk, i) => (
					<Card key={i} className="border-gray-200">
						<CardContent className="p-3">
							<div className="flex items-start gap-3">
								<div className="flex flex-col gap-1 shrink-0">
									<span className={`text-[9px] px-1.5 py-0.5 rounded border font-medium ${severityBadge(risk.severity)}`}>
										深刻度: {levelLabel(risk.severity)}
									</span>
									<span className={`text-[9px] px-1.5 py-0.5 rounded border font-medium ${severityBadge(risk.probability)}`}>
										発生率: {levelLabel(risk.probability)}
									</span>
								</div>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2 mb-0.5">
										<span className="text-[9px] px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">{risk.category}</span>
									</div>
									<p className="text-xs text-gray-800 font-medium">{risk.description}</p>
									<p className="text-[11px] text-gray-500 mt-1">
										<span className="font-medium text-blue-600">対策:</span> {risk.mitigation}
									</p>
								</div>
							</div>
						</CardContent>
					</Card>
				))}
			</div>

			{/* Contingency plans */}
			{(data.contingency_plans ?? []).length > 0 && (
				<Card className="border-orange-200 bg-orange-50/20">
					<CardContent className="p-4">
						<span className="text-xs font-semibold text-orange-700">コンティンジェンシープラン</span>
						<div className="mt-2 space-y-2">
							{data.contingency_plans.map((cp, i) => (
								<div key={i} className="bg-white rounded-lg p-2.5 border border-orange-100">
									<p className="text-xs font-medium text-gray-800">シナリオ: {cp.scenario}</p>
									<p className="text-[11px] text-gray-500 mt-0.5">対応: {cp.response}</p>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Success factors */}
			{(data.success_factors ?? []).length > 0 && (
				<Card className="border-green-200 bg-green-50/20">
					<CardContent className="p-4">
						<div className="flex items-center gap-1.5 mb-2">
							<CheckCircle size={14} className="text-green-600" />
							<span className="text-xs font-semibold text-green-700">成功の重要要因</span>
						</div>
						<ul className="space-y-1">
							{data.success_factors.map((f, i) => (
								<li key={i} className="text-xs text-gray-700 flex items-start gap-1.5">
									<span className="text-green-500 mt-0.5">&#x2713;</span>{f}
								</li>
							))}
						</ul>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
