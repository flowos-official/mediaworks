'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ShieldAlert, AlertTriangle, CheckCircle } from 'lucide-react';
import type { RiskContingencyOutput } from '@/lib/md-strategy';
import SourcesCited from './SourcesCited';

interface Props {
	data: RiskContingencyOutput;
}

function likelihoodColor(l: string): string {
	switch (l) {
		case 'high': return 'bg-red-600/15 text-red-800 dark:text-red-200';
		case 'medium': return 'bg-yellow-500/15 text-yellow-800 dark:text-yellow-200';
		case 'low': return 'bg-green-600/15 text-green-800 dark:text-green-200';
		default: return 'bg-muted text-foreground';
	}
}

function impactColor(i: string): string {
	switch (i) {
		case 'high': return 'bg-red-600/10 text-red-700 dark:text-red-300 border-red-600/30';
		case 'medium': return 'bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 border-yellow-500/30';
		case 'low': return 'bg-green-600/10 text-green-700 dark:text-green-300 border-green-600/30';
		default: return 'bg-muted text-foreground border-border';
	}
}

function categoryLabel(c: string): string {
	switch (c) {
		case 'operational': return '運営';
		case 'financial': return '財務';
		case 'competitive': return '競合';
		case 'regulatory': return '規制';
		case 'market': return '市場';
		default: return c;
	}
}

export default function RiskContingencySection({ data }: Props) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<ShieldAlert size={18} className="text-red-600" />
				<h3 className="text-lg font-bold text-foreground">リスク・対策</h3>
			</div>

			{/* Top 5 Risks */}
			{(data.top_5_risks ?? []).length > 0 && (
				<Card className="border-red-600/30 bg-red-600/5">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold flex items-center gap-1.5 text-red-700 dark:text-red-300">
							<AlertTriangle size={14} /> 重要リスク TOP {data.top_5_risks.length}
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						{(data.top_5_risks ?? []).map((risk, i) => (
							<div key={i} className="bg-card rounded-lg border border-red-600/20 p-3">
								<div className="flex items-start gap-2 mb-2">
									<span className="bg-red-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-[10px] shrink-0 mt-0.5">{i + 1}</span>
									<div>
										<span className="font-semibold text-sm text-foreground">{risk.risk}</span>
										<div className="flex items-center gap-2 mt-0.5">
											<Badge variant="outline" className="text-[9px]">{risk.channel}</Badge>
											<span className="text-[10px] text-muted-foreground">担当: {risk.owner} | レビュー: {risk.review_frequency}</span>
										</div>
									</div>
								</div>
								<div className="ml-7">
									<span className="text-[10px] font-semibold text-muted-foreground uppercase">対応プレイブック</span>
									<ol className="mt-1 space-y-0.5">
										{(risk.mitigation_playbook ?? []).map((step, j) => (
											<li key={j} className="text-xs text-foreground flex gap-2">
												<span className="text-muted-foreground font-mono shrink-0">{j + 1}.</span>
												{step}
											</li>
										))}
									</ol>
								</div>
							</div>
						))}
					</CardContent>
				</Card>
			)}

			{/* Risk matrix per channel */}
			{(data.risk_matrix ?? []).map((ch) => (
				<Card key={ch.channel} className="border-border">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-bold">{ch.channel}</CardTitle>
					</CardHeader>
					<CardContent className="space-y-2">
						{(ch.risks ?? []).map((risk, i) => (
							<div key={i} className="border border-border rounded-lg p-2.5">
								<div className="flex items-center gap-2 mb-1.5">
									<span className="text-xs font-medium text-foreground flex-1">{risk.risk}</span>
									<Badge className={`text-[9px] ${likelihoodColor(risk.likelihood)}`}>
										可能性: {risk.likelihood}
									</Badge>
									<span className={`text-[9px] px-1.5 py-0.5 rounded border ${impactColor(risk.impact)}`}>
										影響: {risk.impact}
									</span>
									<Badge variant="outline" className="text-[9px]">{categoryLabel(risk.category)}</Badge>
								</div>

								{/* Mitigation */}
								{(risk.mitigation ?? []).length > 0 && (
									<div className="text-xs text-muted-foreground mb-1">
										{(risk.mitigation ?? []).map((m, j) => (
											<span key={j}>• {m}{j < (risk.mitigation ?? []).length - 1 ? ' ' : ''}</span>
										))}
									</div>
								)}

								{/* Contingency */}
								{risk.contingency_trigger && (
									<div className="bg-orange-600/10 border border-orange-600/20 rounded px-2 py-1 text-[10px] mt-1">
										<span className="text-orange-700 dark:text-orange-300 font-semibold">発動条件:</span>{' '}
										<span className="text-foreground">{risk.contingency_trigger}</span>
										{risk.contingency_action && (
											<>
												{' → '}
												<span className="text-orange-800 dark:text-orange-200 font-medium">{risk.contingency_action}</span>
											</>
										)}
									</div>
								)}
							</div>
						))}
					</CardContent>
				</Card>
			))}

			{/* Go/No-Go Criteria */}
			{(data.go_nogo_criteria ?? []).length > 0 && (
				<Card className="border-border">
					<CardHeader className="pb-2">
						<CardTitle className="text-sm font-semibold flex items-center gap-1.5">
							<CheckCircle size={14} className="text-emerald-600" /> Go/No-Go判断基準
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-3">
						{(data.go_nogo_criteria ?? []).map((gnc) => (
							<div key={gnc.channel} className="border border-border rounded-lg p-3">
								<div className="flex items-center justify-between mb-2">
									<span className="font-semibold text-sm text-foreground">{gnc.channel}</span>
									<span className="text-[10px] px-2 py-0.5 bg-muted rounded-full text-muted-foreground">
										判断期日: {gnc.decision_date}
									</span>
								</div>
								<ul className="space-y-0.5">
									{(gnc.criteria ?? []).map((c, i) => (
										<li key={i} className="text-xs text-foreground flex gap-2">
											<span className="text-emerald-500 shrink-0">✓</span>
											{c}
										</li>
									))}
								</ul>
							</div>
						))}
					</CardContent>
				</Card>
			)}
			<SourcesCited sources={data.sources_cited} />
		</div>
	);
}
