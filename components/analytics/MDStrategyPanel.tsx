'use client';

import { useState, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, Rocket, AlertTriangle, Target } from 'lucide-react';
import StrategyProgress from './md-strategy/StrategyProgress';
import ProductSelectionSection from './md-strategy/ProductSelectionSection';
import type {
	SkillName,
	ProductSelectionOutput,
	ChannelStrategyOutput,
	PricingMarginOutput,
	MarketingExecutionOutput,
	FinancialProjectionOutput,
	RiskContingencyOutput,
} from '@/lib/md-strategy';

// Lazy imports for section components (created in Step 4)
import dynamic from 'next/dynamic';
const ChannelStrategySection = dynamic(() => import('./md-strategy/ChannelStrategySection'), { ssr: false });
const PricingMarginSection = dynamic(() => import('./md-strategy/PricingMarginSection'), { ssr: false });
const MarketingExecutionSection = dynamic(() => import('./md-strategy/MarketingExecutionSection'), { ssr: false });
const FinancialProjectionSection = dynamic(() => import('./md-strategy/FinancialProjectionSection'), { ssr: false });
const RiskContingencySection = dynamic(() => import('./md-strategy/RiskContingencySection'), { ssr: false });
const StrategyPdfDownload = dynamic(() => import('./md-strategy/StrategyPdfDownload'), { ssr: false });

type SkillStatus = 'pending' | 'running' | 'complete' | 'error';

interface SkillResults {
	product_selection?: ProductSelectionOutput;
	channel_strategy?: ChannelStrategyOutput;
	pricing_margin?: PricingMarginOutput;
	marketing_execution?: MarketingExecutionOutput;
	financial_projection?: FinancialProjectionOutput;
	risk_contingency?: RiskContingencyOutput;
}

const INITIAL_STATUSES: Record<SkillName, SkillStatus> = {
	product_selection: 'pending',
	channel_strategy: 'pending',
	pricing_margin: 'pending',
	marketing_execution: 'pending',
	financial_projection: 'pending',
	risk_contingency: 'pending',
};

export default function MDStrategyPanel() {
	const [userGoal, setUserGoal] = useState('');
	const [status, setStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
	const [dataFetchStatus, setDataFetchStatus] = useState<'pending' | 'running' | 'complete'>('pending');
	const [skillStatuses, setSkillStatuses] = useState<Record<SkillName, SkillStatus>>({ ...INITIAL_STATUSES });
	const [skillResults, setSkillResults] = useState<SkillResults>({});
	const [error, setError] = useState<string | null>(null);
	const [generatedAt, setGeneratedAt] = useState<string | null>(null);

	const handleGenerate = useCallback(async () => {
		setStatus('running');
		setError(null);
		setSkillResults({});
		setSkillStatuses({ ...INITIAL_STATUSES });
		setDataFetchStatus('pending');
		setGeneratedAt(null);

		try {
			const res = await fetch('/api/analytics/md-strategy', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userGoal: userGoal || undefined }),
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}

			const reader = res.body?.getReader();
			if (!reader) throw new Error('No response body');

			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });

				// Parse SSE frames
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				let eventType = '';
				for (const line of lines) {
					if (line.startsWith('event: ')) {
						eventType = line.slice(7).trim();
					} else if (line.startsWith('data: ') && eventType) {
						try {
							const payload = JSON.parse(line.slice(6));
							handleSSEEvent(eventType, payload);
						} catch {
							// Skip malformed JSON
						}
						eventType = '';
					}
				}
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatus('error');
		}
	}, [userGoal]);

	const handleSSEEvent = (event: string, payload: Record<string, unknown>) => {
		switch (event) {
			case 'progress': {
				const skill = payload.skill as string;
				if (skill === 'data_fetch') {
					setDataFetchStatus(payload.status as 'running' | 'complete');
				} else {
					setSkillStatuses((prev) => ({ ...prev, [skill]: 'running' }));
				}
				break;
			}
			case 'skill_result': {
				const skill = payload.skill as SkillName;
				setSkillStatuses((prev) => ({ ...prev, [skill]: 'complete' }));
				setSkillResults((prev) => ({ ...prev, [skill]: payload.data }));
				break;
			}
			case 'skill_error': {
				const skill = payload.skill as SkillName;
				setSkillStatuses((prev) => ({ ...prev, [skill]: 'error' }));
				break;
			}
			case 'complete':
				setStatus('complete');
				setGeneratedAt(payload.generatedAt as string);
				break;
			case 'error':
				setError(payload.message as string);
				setStatus('error');
				break;
		}
	};

	const hasAnyResult = Object.keys(skillResults).length > 0;

	return (
		<div className="space-y-6">
			{/* Input */}
			<div>
				<div className="flex items-center gap-2 mb-3">
					<Target size={18} className="text-indigo-600" />
					<h3 className="text-lg font-semibold text-gray-900">MD戦略プランナー</h3>
					<span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-medium">6-Skill AI</span>
				</div>

				<Card className="border-gray-200 mb-4">
					<CardContent className="p-4">
						<label className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 block">
							戦略の方向性・目標 (任意)
						</label>
						<textarea
							value={userGoal}
							onChange={(e) => setUserGoal(e.target.value)}
							placeholder="例: 楽天・Amazonで月商1000万を目指したい / TikTokで若年層にリーチしたい / 韓国Coupangへの越境ECを検討中 / 自社ECでD2Cブランドを構築したい"
							rows={3}
							disabled={status === 'running'}
							className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none disabled:opacity-50"
						/>
						<div className="flex items-center justify-between mt-3">
							<p className="text-[10px] text-gray-400">
								6つの専門スキル（商品選定→チャネル戦略→価格設計→マーケ計画→収益予測→リスク対策）が順次分析します
							</p>
							{status === 'running' ? (
								<button type="button" disabled className="flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white text-sm font-semibold rounded-lg opacity-60">
									<Loader2 size={14} className="animate-spin" />
									AI分析中...
								</button>
							) : (
								<button
									type="button"
									onClick={handleGenerate}
									className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-semibold rounded-lg transition-colors"
								>
									<Rocket size={14} />
									MD戦略を生成
								</button>
							)}
						</div>
					</CardContent>
				</Card>
			</div>

			{/* Error */}
			{error && (
				<div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
					<AlertTriangle size={14} />
					{error}
				</div>
			)}

			{/* Progress panel (while running) */}
			{status === 'running' && (
				<StrategyProgress skillStatuses={skillStatuses} dataFetchStatus={dataFetchStatus} />
			)}

			{/* Results — render progressively as each skill completes */}
			{hasAnyResult && (
				<div id="md-strategy-content" className="space-y-8">
					{skillResults.product_selection && (
						<ProductSelectionSection data={skillResults.product_selection} />
					)}
					{skillResults.channel_strategy && (
						<ChannelStrategySection data={skillResults.channel_strategy} />
					)}
					{skillResults.pricing_margin && (
						<PricingMarginSection data={skillResults.pricing_margin} />
					)}
					{skillResults.marketing_execution && (
						<MarketingExecutionSection data={skillResults.marketing_execution} />
					)}
					{skillResults.financial_projection && (
						<FinancialProjectionSection data={skillResults.financial_projection} />
					)}
					{skillResults.risk_contingency && (
						<RiskContingencySection data={skillResults.risk_contingency} />
					)}
				</div>
			)}

			{/* Footer */}
			{generatedAt && (
				<div className="flex items-center justify-between">
					<p className="text-[10px] text-gray-400">
						生成: {new Date(generatedAt).toLocaleString('ja-JP')}
						{userGoal && ` | 目標: "${userGoal.slice(0, 40)}${userGoal.length > 40 ? '...' : ''}"`}
					</p>
					<StrategyPdfDownload />
				</div>
			)}
		</div>
	);
}
