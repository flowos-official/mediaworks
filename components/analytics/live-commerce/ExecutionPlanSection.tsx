'use client';

import { Card, CardContent } from '@/components/ui/card';
import { CalendarDays, DollarSign, UserPlus, Wrench } from 'lucide-react';
import type { ExecutionPlanOutput } from '@/lib/live-commerce-strategy';

interface Props {
	data: ExecutionPlanOutput;
}

const PHASE_COLORS = [
	{ bg: 'bg-blue-600/10', border: 'border-blue-600/30', badge: 'bg-blue-600', text: 'text-blue-700 dark:text-blue-300' },
	{ bg: 'bg-green-600/10', border: 'border-green-600/30', badge: 'bg-green-600', text: 'text-green-700 dark:text-green-300' },
	{ bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', badge: 'bg-yellow-600', text: 'text-yellow-700 dark:text-yellow-300' },
	{ bg: 'bg-purple-600/10', border: 'border-purple-600/30', badge: 'bg-purple-600', text: 'text-purple-700 dark:text-purple-300' },
];

export default function ExecutionPlanSection({ data }: Props) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<CalendarDays size={18} className="text-indigo-600" />
				<h3 className="text-lg font-bold text-foreground">実行ロードマップ</h3>
			</div>

			{/* Total investment */}
			{data.total_investment && (
				<div className="bg-indigo-600/10 border border-indigo-600/30 rounded-lg p-3 flex items-center gap-2">
					<DollarSign size={16} className="text-indigo-600" />
					<span className="text-sm font-semibold text-indigo-700 dark:text-indigo-300">初年度総投資: {data.total_investment}</span>
				</div>
			)}

			{/* Phases */}
			<div className="space-y-4">
				{(data.phases ?? []).map((phase, i) => {
					const color = PHASE_COLORS[i % PHASE_COLORS.length];
					return (
						<Card key={i} className={`${color.border} ${color.bg}`}>
							<CardContent className="p-4">
								<div className="flex items-center gap-2 mb-3">
									<span className={`${color.badge} text-white rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold`}>{i + 1}</span>
									<div>
										<span className="text-sm font-semibold text-foreground">{phase.phase}</span>
										<span className="text-xs text-muted-foreground ml-2">{phase.period}</span>
									</div>
									{phase.budget && (
										<span className="ml-auto text-xs font-mono text-muted-foreground">{phase.budget}</span>
									)}
								</div>

								{/* Objectives */}
								<div className="mb-3">
									<span className="text-[10px] font-semibold text-muted-foreground uppercase">目標</span>
									<ul className="mt-1 space-y-0.5">
										{(phase.objectives ?? []).map((obj, j) => (
											<li key={j} className="text-xs text-foreground flex items-start gap-1">
												<span className={`${color.text} mt-0.5`}>&#x25B6;</span>{obj}
											</li>
										))}
									</ul>
								</div>

								{/* Actions */}
								<div className="mb-3">
									<span className="text-[10px] font-semibold text-muted-foreground uppercase">アクション</span>
									<div className="mt-1 space-y-1">
										{(phase.actions ?? []).map((a, j) => (
											<div key={j} className="flex items-center gap-2 text-xs bg-card/60 rounded px-2 py-1 border border-border">
												<span className="text-foreground flex-1">{a.action}</span>
												<span className="text-muted-foreground shrink-0">{a.owner}</span>
												<span className="text-muted-foreground shrink-0">{a.deadline}</span>
											</div>
										))}
									</div>
								</div>

								{/* KPIs */}
								{(phase.kpis ?? []).length > 0 && (
									<div>
										<span className="text-[10px] font-semibold text-muted-foreground uppercase">KPI</span>
										<div className="mt-1 flex flex-wrap gap-2">
											{phase.kpis.map((kpi, j) => (
												<span key={j} className="text-[11px] px-2 py-0.5 bg-card rounded border border-border">
													{kpi.metric}: <span className="font-medium">{kpi.target}</span>
												</span>
											))}
										</div>
									</div>
								)}
							</CardContent>
						</Card>
					);
				})}
			</div>

			{/* Staffing */}
			{(data.staffing ?? []).length > 0 && (
				<Card className="border-border">
					<CardContent className="p-4">
						<div className="flex items-center gap-1.5 mb-2">
							<UserPlus size={14} className="text-indigo-600" />
							<span className="text-xs font-semibold text-muted-foreground">人員計画</span>
						</div>
						<div className="space-y-1">
							{data.staffing.map((s, i) => (
								<div key={i} className="flex items-center gap-3 text-xs bg-muted rounded px-2 py-1.5 border border-border">
									<span className="font-medium text-foreground">{s.role}</span>
									<span className="text-muted-foreground">{s.type}</span>
									<span className="ml-auto text-muted-foreground">{s.timing}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Tools */}
			{(data.tools_and_services ?? []).length > 0 && (
				<Card className="border-border">
					<CardContent className="p-4">
						<div className="flex items-center gap-1.5 mb-2">
							<Wrench size={14} className="text-muted-foreground" />
							<span className="text-xs font-semibold text-muted-foreground">ツール・サービス</span>
						</div>
						<div className="space-y-1">
							{data.tools_and_services.map((t, i) => (
								<div key={i} className="flex items-center gap-3 text-xs bg-muted rounded px-2 py-1.5 border border-border">
									<span className="font-medium text-foreground">{t.name}</span>
									<span className="text-muted-foreground flex-1">{t.purpose}</span>
									<span className="font-mono text-muted-foreground shrink-0">{t.cost}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
