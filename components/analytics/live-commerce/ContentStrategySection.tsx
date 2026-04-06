'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Video, Clock, Mic, Zap } from 'lucide-react';
import type { ContentStrategyOutput } from '@/lib/live-commerce-strategy';

interface Props {
	data: ContentStrategyOutput;
}

export default function ContentStrategySection({ data }: Props) {
	const platforms = data.platforms ?? [];
	const [activeTab, setActiveTab] = useState(platforms[0]?.name ?? '');

	const activePlatform = platforms.find((p) => p.name === activeTab);

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Video size={18} className="text-pink-600" />
				<h3 className="text-lg font-bold text-gray-900">コンテンツ戦略</h3>
			</div>

			{/* Platform tabs */}
			{platforms.length > 0 && (
				<div className="flex gap-1 p-1 bg-gray-100 rounded-xl overflow-x-auto">
					{platforms.map((p) => (
						<button
							key={p.name}
							type="button"
							onClick={() => setActiveTab(p.name)}
							className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all whitespace-nowrap ${
								activeTab === p.name ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
							}`}
						>
							{p.name}
						</button>
					))}
				</div>
			)}

			{activePlatform && (
				<div className="space-y-3">
					{/* Format + timing + frequency */}
					<div className="grid grid-cols-3 gap-2">
						<Card className="border-gray-200">
							<CardContent className="p-3">
								<div className="flex items-center gap-1 mb-1">
									<Video size={12} className="text-pink-500" />
									<span className="text-[10px] font-semibold text-gray-500">配信形式</span>
								</div>
								<p className="text-xs text-gray-700">{activePlatform.broadcast_format}</p>
							</CardContent>
						</Card>
						<Card className="border-gray-200">
							<CardContent className="p-3">
								<div className="flex items-center gap-1 mb-1">
									<Clock size={12} className="text-blue-500" />
									<span className="text-[10px] font-semibold text-gray-500">最適時間帯</span>
								</div>
								<div className="space-y-0.5">
									{(activePlatform.optimal_times ?? []).map((t, i) => (
										<p key={i} className="text-xs text-gray-700">{t}</p>
									))}
								</div>
							</CardContent>
						</Card>
						<Card className="border-gray-200">
							<CardContent className="p-3">
								<div className="flex items-center gap-1 mb-1">
									<Mic size={12} className="text-purple-500" />
									<span className="text-[10px] font-semibold text-gray-500">配信頻度</span>
								</div>
								<p className="text-xs text-gray-700">{activePlatform.frequency}</p>
							</CardContent>
						</Card>
					</div>

					{/* Host style */}
					<div className="bg-pink-50 border border-pink-200 rounded-lg p-3">
						<span className="text-[10px] font-semibold text-pink-600 uppercase">推奨ホストスタイル</span>
						<p className="text-sm text-gray-700 mt-1">{activePlatform.host_style}</p>
					</div>

					{/* Content ideas */}
					<Card className="border-gray-200">
						<CardContent className="p-4">
							<div className="flex items-center gap-1.5 mb-3">
								<Zap size={14} className="text-yellow-600" />
								<span className="text-xs font-semibold text-gray-600">コンテンツ企画</span>
							</div>
							<div className="space-y-2">
								{(activePlatform.content_ideas ?? []).map((idea, i) => (
									<div key={i} className="bg-gray-50 rounded-lg p-2.5 border border-gray-100">
										<div className="flex items-center gap-2 mb-0.5">
											<span className="text-xs font-medium text-gray-800">{idea.title}</span>
											<span className="text-[9px] px-1.5 py-0.5 bg-yellow-50 text-yellow-700 rounded">{idea.format}</span>
										</div>
										<p className="text-[11px] text-gray-500">{idea.description}</p>
									</div>
								))}
							</div>
						</CardContent>
					</Card>

					{/* Engagement tactics */}
					<Card className="border-gray-200">
						<CardContent className="p-4">
							<span className="text-xs font-semibold text-gray-600">エンゲージメント施策</span>
							<ul className="mt-2 space-y-1">
								{(activePlatform.engagement_tactics ?? []).map((t, i) => (
									<li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
										<span className="text-pink-500 mt-0.5">&#x25CF;</span>{t}
									</li>
								))}
							</ul>
						</CardContent>
					</Card>

					{/* Script outline */}
					{activePlatform.sample_script_outline && (
						<Card className="border-gray-200">
							<CardContent className="p-4">
								<span className="text-xs font-semibold text-gray-600">サンプルスクリプト</span>
								<p className="text-sm text-gray-700 mt-2 whitespace-pre-line leading-relaxed bg-gray-50 rounded-lg p-3 border border-gray-100">
									{activePlatform.sample_script_outline}
								</p>
							</CardContent>
						</Card>
					)}
				</div>
			)}

			{/* Cross-platform strategy */}
			{data.cross_platform_strategy && (
				<div className="bg-pink-50 border border-pink-200 rounded-lg p-4">
					<span className="text-xs font-semibold text-pink-700">クロスプラットフォーム戦略</span>
					<p className="text-sm text-gray-700 mt-1 leading-relaxed">{data.cross_platform_strategy}</p>
				</div>
			)}
		</div>
	);
}
