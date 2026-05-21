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
				<h3 className="text-lg font-bold text-foreground">コンテンツ戦略</h3>
			</div>

			{/* Platform tabs */}
			{platforms.length > 0 && (
				<div className="flex gap-1 p-1 bg-muted rounded-xl overflow-x-auto">
					{platforms.map((p) => (
						<button
							key={p.name}
							type="button"
							onClick={() => setActiveTab(p.name)}
							className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-all whitespace-nowrap ${
								activeTab === p.name ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
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
						<Card className="border-border">
							<CardContent className="p-3">
								<div className="flex items-center gap-1 mb-1">
									<Video size={12} className="text-pink-500" />
									<span className="text-[10px] font-semibold text-muted-foreground">配信形式</span>
								</div>
								<p className="text-xs text-foreground">{activePlatform.broadcast_format}</p>
							</CardContent>
						</Card>
						<Card className="border-border">
							<CardContent className="p-3">
								<div className="flex items-center gap-1 mb-1">
									<Clock size={12} className="text-blue-500" />
									<span className="text-[10px] font-semibold text-muted-foreground">最適時間帯</span>
								</div>
								<div className="space-y-0.5">
									{(activePlatform.optimal_times ?? []).map((t, i) => (
										<p key={i} className="text-xs text-foreground">{t}</p>
									))}
								</div>
							</CardContent>
						</Card>
						<Card className="border-border">
							<CardContent className="p-3">
								<div className="flex items-center gap-1 mb-1">
									<Mic size={12} className="text-purple-500" />
									<span className="text-[10px] font-semibold text-muted-foreground">配信頻度</span>
								</div>
								<p className="text-xs text-foreground">{activePlatform.frequency}</p>
							</CardContent>
						</Card>
					</div>

					{/* Host style */}
					<div className="bg-pink-600/10 border border-pink-600/30 rounded-lg p-3">
						<span className="text-[10px] font-semibold text-pink-600 dark:text-pink-300 uppercase">推奨ホストスタイル</span>
						<p className="text-sm text-foreground mt-1">{activePlatform.host_style}</p>
					</div>

					{/* Content ideas */}
					<Card className="border-border">
						<CardContent className="p-4">
							<div className="flex items-center gap-1.5 mb-3">
								<Zap size={14} className="text-yellow-600" />
								<span className="text-xs font-semibold text-muted-foreground">コンテンツ企画</span>
							</div>
							<div className="space-y-2">
								{(activePlatform.content_ideas ?? []).map((idea, i) => (
									<div key={i} className="bg-muted rounded-lg p-2.5 border border-border">
										<div className="flex items-center gap-2 mb-0.5">
											<span className="text-xs font-medium text-foreground">{idea.title}</span>
											<span className="text-[9px] px-1.5 py-0.5 bg-yellow-500/10 text-yellow-700 dark:text-yellow-300 rounded">{idea.format}</span>
										</div>
										<p className="text-[11px] text-muted-foreground">{idea.description}</p>
									</div>
								))}
							</div>
						</CardContent>
					</Card>

					{/* Engagement tactics */}
					<Card className="border-border">
						<CardContent className="p-4">
							<span className="text-xs font-semibold text-muted-foreground">エンゲージメント施策</span>
							<ul className="mt-2 space-y-1">
								{(activePlatform.engagement_tactics ?? []).map((t, i) => (
									<li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
										<span className="text-pink-500 mt-0.5">&#x25CF;</span>{t}
									</li>
								))}
							</ul>
						</CardContent>
					</Card>

					{/* Script outline */}
					{activePlatform.sample_script_outline && (
						<Card className="border-border">
							<CardContent className="p-4">
								<span className="text-xs font-semibold text-muted-foreground">サンプルスクリプト</span>
								<p className="text-sm text-foreground mt-2 whitespace-pre-line leading-relaxed bg-muted rounded-lg p-3 border border-border">
									{activePlatform.sample_script_outline}
								</p>
							</CardContent>
						</Card>
					)}
				</div>
			)}

			{/* Cross-platform strategy */}
			{data.cross_platform_strategy && (
				<div className="bg-pink-600/10 border border-pink-600/30 rounded-lg p-4">
					<span className="text-xs font-semibold text-pink-700 dark:text-pink-300">クロスプラットフォーム戦略</span>
					<p className="text-sm text-foreground mt-1 leading-relaxed">{data.cross_platform_strategy}</p>
				</div>
			)}
		</div>
	);
}
