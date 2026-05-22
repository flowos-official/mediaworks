'use client';

import { Card, CardContent } from '@/components/ui/card';
import { ShieldAlert, CheckCircle } from 'lucide-react';
import type { RiskAnalysisOutput } from '@/lib/live-commerce-strategy';

interface Props {
	data: RiskAnalysisOutput;
}

function severityBadge(level: string): string {
	switch (level) {
		case 'high': return 'bg-red-600/15 text-red-700 dark:text-red-300 border-red-600/30';
		case 'medium': return 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-300 border-yellow-500/30';
		case 'low': return 'bg-green-600/15 text-green-700 dark:text-green-300 border-green-600/30';
		default: return 'bg-muted text-muted-foreground border-border';
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
				<h3 className="text-lg font-bold text-foreground">リスク分析</h3>
			</div>

			{/* Risk cards */}
			<div className="space-y-2">
				{(data.risks ?? []).map((risk, i) => (
					<Card key={i} className="border-border">
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
										<span className="text-[9px] px-1.5 py-0.5 bg-muted text-muted-foreground rounded">{risk.category}</span>
									</div>
									<p className="text-xs text-foreground font-medium">{risk.description}</p>
									<p className="text-[11px] text-muted-foreground mt-1">
										<span className="font-medium text-blue-600 dark:text-blue-400">対策:</span> {risk.mitigation}
									</p>
								</div>
							</div>
						</CardContent>
					</Card>
				))}
			</div>

			{/* Contingency plans */}
			{(data.contingency_plans ?? []).length > 0 && (
				<Card className="border-orange-600/30 bg-orange-600/5">
					<CardContent className="p-4">
						<span className="text-xs font-semibold text-orange-700 dark:text-orange-300">コンティンジェンシープラン</span>
						<div className="mt-2 space-y-2">
							{data.contingency_plans.map((cp, i) => (
								<div key={i} className="bg-card rounded-lg p-2.5 border border-orange-600/20">
									<p className="text-xs font-medium text-foreground">シナリオ: {cp.scenario}</p>
									<p className="text-[11px] text-muted-foreground mt-0.5">対応: {cp.response}</p>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Success factors */}
			{(data.success_factors ?? []).length > 0 && (
				<Card className="border-green-600/30 bg-green-600/5">
					<CardContent className="p-4">
						<div className="flex items-center gap-1.5 mb-2">
							<CheckCircle size={14} className="text-green-600" />
							<span className="text-xs font-semibold text-green-700 dark:text-green-300">成功の重要要因</span>
						</div>
						<ul className="space-y-1">
							{data.success_factors.map((f, i) => (
								<li key={i} className="text-xs text-foreground flex items-start gap-1.5">
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
