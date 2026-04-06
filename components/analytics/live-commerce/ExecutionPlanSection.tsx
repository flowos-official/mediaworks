'use client';

import { Card, CardContent } from '@/components/ui/card';
import { CalendarDays, DollarSign, UserPlus, Wrench } from 'lucide-react';
import type { ExecutionPlanOutput } from '@/lib/live-commerce-strategy';

interface Props {
	data: ExecutionPlanOutput;
}

const PHASE_COLORS = [
	{ bg: 'bg-blue-50', border: 'border-blue-200', badge: 'bg-blue-600', text: 'text-blue-700' },
	{ bg: 'bg-green-50', border: 'border-green-200', badge: 'bg-green-600', text: 'text-green-700' },
	{ bg: 'bg-yellow-50', border: 'border-yellow-200', badge: 'bg-yellow-600', text: 'text-yellow-700' },
	{ bg: 'bg-purple-50', border: 'border-purple-200', badge: 'bg-purple-600', text: 'text-purple-700' },
];

export default function ExecutionPlanSection({ data }: Props) {
	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<CalendarDays size={18} className="text-indigo-600" />
				<h3 className="text-lg font-bold text-gray-900">実行ロードマップ</h3>
			</div>

			{/* Total investment */}
			{data.total_investment && (
				<div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 flex items-center gap-2">
					<DollarSign size={16} className="text-indigo-600" />
					<span className="text-sm font-semibold text-indigo-700">初年度総投資: {data.total_investment}</span>
				</div>
			)}

			{/* Phases */}
			<div className="space-y-4">
				{(data.phases ?? []).map((phase, i) => {
					const color = PHASE_COLORS[i % PHASE_COLORS.length];
					return (
						<Card key={i} className={`${color.border} ${color.bg}/30`}>
							<CardContent className="p-4">
								<div className="flex items-center gap-2 mb-3">
									<span className={`${color.badge} text-white rounded-full w-6 h-6 flex items-center justify-center text-xs font-bold`}>{i + 1}</span>
									<div>
										<span className="text-sm font-semibold text-gray-900">{phase.phase}</span>
										<span className="text-xs text-gray-500 ml-2">{phase.period}</span>
									</div>
									{phase.budget && (
										<span className="ml-auto text-xs font-mono text-gray-500">{phase.budget}</span>
									)}
								</div>

								{/* Objectives */}
								<div className="mb-3">
									<span className="text-[10px] font-semibold text-gray-500 uppercase">目標</span>
									<ul className="mt-1 space-y-0.5">
										{(phase.objectives ?? []).map((obj, j) => (
											<li key={j} className="text-xs text-gray-700 flex items-start gap-1">
												<span className={`${color.text} mt-0.5`}>&#x25B6;</span>{obj}
											</li>
										))}
									</ul>
								</div>

								{/* Actions */}
								<div className="mb-3">
									<span className="text-[10px] font-semibold text-gray-500 uppercase">アクション</span>
									<div className="mt-1 space-y-1">
										{(phase.actions ?? []).map((a, j) => (
											<div key={j} className="flex items-center gap-2 text-xs bg-white/60 rounded px-2 py-1 border border-gray-100">
												<span className="text-gray-700 flex-1">{a.action}</span>
												<span className="text-gray-400 shrink-0">{a.owner}</span>
												<span className="text-gray-400 shrink-0">{a.deadline}</span>
											</div>
										))}
									</div>
								</div>

								{/* KPIs */}
								{(phase.kpis ?? []).length > 0 && (
									<div>
										<span className="text-[10px] font-semibold text-gray-500 uppercase">KPI</span>
										<div className="mt-1 flex flex-wrap gap-2">
											{phase.kpis.map((kpi, j) => (
												<span key={j} className="text-[11px] px-2 py-0.5 bg-white rounded border border-gray-200">
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
				<Card className="border-gray-200">
					<CardContent className="p-4">
						<div className="flex items-center gap-1.5 mb-2">
							<UserPlus size={14} className="text-indigo-600" />
							<span className="text-xs font-semibold text-gray-600">人員計画</span>
						</div>
						<div className="space-y-1">
							{data.staffing.map((s, i) => (
								<div key={i} className="flex items-center gap-3 text-xs bg-gray-50 rounded px-2 py-1.5 border border-gray-100">
									<span className="font-medium text-gray-800">{s.role}</span>
									<span className="text-gray-400">{s.type}</span>
									<span className="ml-auto text-gray-500">{s.timing}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}

			{/* Tools */}
			{(data.tools_and_services ?? []).length > 0 && (
				<Card className="border-gray-200">
					<CardContent className="p-4">
						<div className="flex items-center gap-1.5 mb-2">
							<Wrench size={14} className="text-gray-600" />
							<span className="text-xs font-semibold text-gray-600">ツール・サービス</span>
						</div>
						<div className="space-y-1">
							{data.tools_and_services.map((t, i) => (
								<div key={i} className="flex items-center gap-3 text-xs bg-gray-50 rounded px-2 py-1.5 border border-gray-100">
									<span className="font-medium text-gray-800">{t.name}</span>
									<span className="text-gray-500 flex-1">{t.purpose}</span>
									<span className="font-mono text-gray-500 shrink-0">{t.cost}</span>
								</div>
							))}
						</div>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
