'use client';

import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Monitor, ChevronDown, ChevronUp, Star, Package, ExternalLink } from 'lucide-react';
import type { PlatformAnalysisOutput } from '@/lib/live-commerce-strategy';

interface Props {
	data: PlatformAnalysisOutput;
}

const EXTERNAL_SEARCH_URLS: Record<string, (keyword: string) => string> = {
	"楽天ROOM LIVE": (k) => `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(k)}/`,
	"Yahoo!ショッピング LIVE": (k) => `https://shopping.yahoo.co.jp/search?p=${encodeURIComponent(k)}`,
	"TikTok Live": (k) => `https://www.tiktok.com/search?q=${encodeURIComponent(k)}`,
	"Instagram Live": (k) => `https://www.instagram.com/explore/tags/${encodeURIComponent(k.replace(/\s+/g, ''))}/`,
	"YouTube Live": (k) => `https://www.youtube.com/results?search_query=${encodeURIComponent(k)}`,
};

function scoreColor(score: number): string {
	if (score >= 80) return 'text-green-700 bg-green-50 border-green-200';
	if (score >= 60) return 'text-blue-700 bg-blue-50 border-blue-200';
	if (score >= 40) return 'text-yellow-700 bg-yellow-50 border-yellow-200';
	return 'text-red-700 bg-red-50 border-red-200';
}

export default function PlatformAnalysisSection({ data }: Props) {
	const [expanded, setExpanded] = useState<string | null>(null);

	return (
		<div className="space-y-4">
			<div className="flex items-center gap-2">
				<Monitor size={18} className="text-blue-600" />
				<h3 className="text-lg font-bold text-gray-900">プラットフォーム分析</h3>
			</div>

			{/* Priority order */}
			{(data.recommended_priority ?? []).length > 0 && (
				<div className="flex items-center gap-2 flex-wrap">
					<span className="text-xs font-semibold text-gray-500">推奨優先度:</span>
					{data.recommended_priority.map((name, i) => (
						<span key={name} className="flex items-center gap-1 text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-full border border-blue-200">
							<Star size={10} className={i === 0 ? 'fill-blue-600' : ''} />
							{name}
						</span>
					))}
				</div>
			)}

			{/* Platform cards */}
			<div className="space-y-3">
				{(data.platforms ?? []).map((platform) => {
					const isExpanded = expanded === platform.name;
					return (
						<Card key={platform.name} className="border-gray-200">
							<button
								type="button"
								onClick={() => setExpanded(isExpanded ? null : platform.name)}
								className="w-full text-left"
							>
								<CardContent className="p-4">
									<div className="flex items-center justify-between">
										<div className="flex items-center gap-3">
											<span className={`text-sm font-bold px-2.5 py-1 rounded-lg border ${scoreColor(platform.fit_score)}`}>
												{platform.fit_score}
											</span>
											<div>
												<span className="text-sm font-semibold text-gray-900">{platform.name}</span>
												<p className="text-xs text-gray-500">{platform.user_base}</p>
											</div>
										</div>
										{isExpanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
									</div>

									{isExpanded && (
										<div className="mt-4 space-y-3 border-t border-gray-100 pt-3">
											<div className="text-xs text-gray-500">
												<span className="font-semibold">手数料:</span> {platform.commission_structure}
											</div>

											<div className="grid grid-cols-2 gap-3">
												<div>
													<span className="text-[10px] font-semibold text-green-600 uppercase">強み</span>
													<ul className="mt-1 space-y-0.5">
														{(platform.strengths ?? []).map((s, i) => (
															<li key={i} className="text-xs text-gray-600 flex items-start gap-1">
																<span className="text-green-500 mt-0.5">+</span>{s}
															</li>
														))}
													</ul>
												</div>
												<div>
													<span className="text-[10px] font-semibold text-red-600 uppercase">弱み</span>
													<ul className="mt-1 space-y-0.5">
														{(platform.weaknesses ?? []).map((w, i) => (
															<li key={i} className="text-xs text-gray-600 flex items-start gap-1">
																<span className="text-red-500 mt-0.5">-</span>{w}
															</li>
														))}
													</ul>
												</div>
											</div>

											{(platform.success_cases ?? []).length > 0 && (
												<div>
													<span className="text-[10px] font-semibold text-purple-600 uppercase">成功事例</span>
													<div className="mt-1 space-y-1.5">
														{platform.success_cases.map((c, i) => (
															<div key={i} className="bg-purple-50/50 rounded-lg p-2 border border-purple-100">
																<span className="text-xs font-medium text-gray-800">{c.brand}</span>
																<p className="text-[11px] text-gray-500">{c.description}</p>
																<p className="text-[11px] text-purple-700 font-medium mt-0.5">{c.result}</p>
															</div>
														))}
													</div>
												</div>
											)}

											{(platform.entry_steps ?? []).length > 0 && (
												<div>
													<span className="text-[10px] font-semibold text-blue-600 uppercase">参入ステップ</span>
													<ol className="mt-1 space-y-0.5">
														{platform.entry_steps.map((step, i) => (
															<li key={i} className="text-xs text-gray-600 flex items-start gap-1.5">
																<span className="bg-blue-100 text-blue-700 rounded-full w-4 h-4 flex items-center justify-center text-[9px] shrink-0 mt-0.5">{i + 1}</span>
																{step}
															</li>
														))}
													</ol>
												</div>
											)}

											{/* Our recommended products */}
											{(platform.our_recommended_products ?? []).length > 0 && (
												<div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
													<div className="flex items-center gap-1.5 mb-2">
														<Package size={12} className="text-blue-600" />
														<span className="text-[10px] font-semibold text-blue-700 uppercase">自社おすすめ商品</span>
													</div>
													<div className="space-y-1.5">
														{platform.our_recommended_products.map((p) => (
															<div key={p.code} className="bg-white rounded px-2 py-1.5 border border-blue-100">
																<div className="flex items-center gap-2">
																	<span className="text-[9px] font-mono text-blue-500">{p.code}</span>
																	<span className="text-xs font-medium text-gray-800">{p.name}</span>
																</div>
																<p className="text-[11px] text-gray-500 mt-0.5">{p.reason}</p>
															</div>
														))}
													</div>
												</div>
											)}

											{/* External search links */}
											{(platform.search_keywords ?? []).length > 0 && (
												<div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
													<div className="flex items-center gap-1.5 mb-2">
														<ExternalLink size={12} className="text-gray-600" />
														<span className="text-[10px] font-semibold text-gray-600 uppercase">外部で商品を検索</span>
													</div>
													<div className="flex flex-wrap gap-1.5">
														{platform.search_keywords.map((keyword) => {
															const buildUrl = EXTERNAL_SEARCH_URLS[platform.name];
															if (!buildUrl) return null;
															return (
																<a
																	key={keyword}
																	href={buildUrl(keyword)}
																	target="_blank"
																	rel="noopener noreferrer"
																	className="inline-flex items-center gap-1 text-[11px] px-2 py-1 bg-white border border-gray-200 rounded-lg text-gray-700 hover:border-blue-300 hover:text-blue-700 transition-colors"
																>
																	<ExternalLink size={9} />
																	{keyword}
																</a>
															);
														})}
													</div>
												</div>
											)}
										</div>
									)}
								</CardContent>
							</button>
						</Card>
					);
				})}
			</div>

			{/* Comparison summary */}
			{data.comparison_summary && (
				<div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
					<span className="text-xs font-semibold text-blue-700">比較総括</span>
					<p className="text-sm text-gray-700 mt-1 leading-relaxed">{data.comparison_summary}</p>
				</div>
			)}
		</div>
	);
}
