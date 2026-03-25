'use client';

import { CheckCircle, Loader2, Circle, AlertTriangle } from 'lucide-react';
import { SKILL_META } from '@/lib/md-strategy';
import type { SkillName } from '@/lib/md-strategy';

type SkillStatus = 'pending' | 'running' | 'complete' | 'error';

interface Props {
	skillStatuses: Record<SkillName, SkillStatus>;
	dataFetchStatus: 'pending' | 'running' | 'complete';
}

const SKILL_ORDER: SkillName[] = [
	'product_selection',
	'channel_strategy',
	'pricing_margin',
	'marketing_execution',
	'financial_projection',
	'risk_contingency',
];

export default function StrategyProgress({ skillStatuses, dataFetchStatus }: Props) {
	return (
		<div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
			<h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">分析進捗</h4>

			{/* Data fetch step */}
			<div className="flex items-center gap-3 mb-2 pb-2 border-b border-gray-100">
				<StatusIcon status={dataFetchStatus} />
				<span className={`text-sm ${dataFetchStatus === 'running' ? 'text-blue-700 font-medium' : 'text-gray-600'}`}>
					データ取得
				</span>
			</div>

			{/* Skill steps */}
			<div className="space-y-1.5">
				{SKILL_ORDER.map((skill, i) => {
					const status = skillStatuses[skill];
					const meta = SKILL_META[skill];
					return (
						<div key={skill} className="flex items-center gap-3">
							{/* Connector line */}
							<div className="relative flex items-center justify-center w-5">
								{i > 0 && (
									<div className={`absolute -top-2.5 w-px h-2.5 ${
										skillStatuses[SKILL_ORDER[i - 1]] === 'complete' ? 'bg-green-300' : 'bg-gray-200'
									}`} />
								)}
								<StatusIcon status={status} />
							</div>
							<div className="flex items-center gap-2 flex-1 min-w-0">
								<span className={`text-sm truncate ${
									status === 'running' ? 'text-blue-700 font-medium' :
									status === 'complete' ? 'text-gray-700' :
									status === 'error' ? 'text-red-600' :
									'text-gray-400'
								}`}>
									{meta.labelJa}
								</span>
								{status === 'running' && (
									<span className="text-[10px] text-blue-500 animate-pulse">分析中...</span>
								)}
							</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}

function StatusIcon({ status }: { status: string }) {
	switch (status) {
		case 'complete':
			return <CheckCircle size={16} className="text-green-500 shrink-0" />;
		case 'running':
			return <Loader2 size={16} className="text-blue-600 animate-spin shrink-0" />;
		case 'error':
			return <AlertTriangle size={16} className="text-red-500 shrink-0" />;
		default:
			return <Circle size={16} className="text-gray-300 shrink-0" />;
	}
}
