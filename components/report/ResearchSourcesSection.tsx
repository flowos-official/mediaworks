"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useState, useMemo } from "react";
import { Search, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";

const CATEGORY_ORDER = [
	"market_overview", "target_demographics", "seasonality", "cogs_alibaba",
	"influencers", "content_marketing", "japan_market", "japan_price", "japan_reviews",
	"tv_shopping_hit_products", "tv_shopping_similar", "tv_shopping_viewer_demographics",
	"tv_shopping_market_data", "rakuten_ranking",
];

interface ParsedSource {
	title: string;
	snippet: string;
	url: string;
}

function parseSearchResults(
	searchResults: Record<string, string>
): Record<string, ParsedSource[] | string> {
	const parsed: Record<string, ParsedSource[] | string> = {};

	for (const [key, value] of Object.entries(searchResults)) {
		if (key === "rakuten_ranking") {
			parsed[key] = value;
			continue;
		}

		const blocks = value.split("\n\n");
		const sources: ParsedSource[] = [];

		for (const block of blocks) {
			const lines = block.split("\n");
			let title = "";
			let snippet = "";
			let url = "";

			for (const line of lines) {
				if (line.startsWith("Title: ")) {
					title = line.slice("Title: ".length).trim();
				} else if (line.startsWith("Description: ")) {
					snippet = line.slice("Description: ".length).trim();
				} else if (line.startsWith("URL: ")) {
					url = line.slice("URL: ".length).trim();
				}
			}

			if (url && (url.startsWith("http://") || url.startsWith("https://"))) {
				sources.push({ title, snippet, url });
			}
		}

		if (sources.length > 0) {
			parsed[key] = sources;
		}
	}

	return parsed;
}

interface ResearchSourcesSectionProps {
	searchResults: Record<string, string>;
}

export default function ResearchSourcesSection({ searchResults }: ResearchSourcesSectionProps) {
	const t = useTranslations("report");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());

	const parsed = useMemo(() => parseSearchResults(searchResults), [searchResults]);

	const totalCount = useMemo(() => {
		let count = 0;
		for (const value of Object.values(parsed)) {
			if (Array.isArray(value)) {
				count += value.length;
			} else {
				count += 1;
			}
		}
		return count;
	}, [parsed]);

	const toggleCategory = (key: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	};

	if (totalCount === 0) return null;

	return (
		<Card>
			<CardContent className="p-6">
				<div className="flex items-center gap-2 mb-5">
					<Search className="h-5 w-5 text-blue-500" />
					<h3 className="text-lg font-semibold text-gray-900">{t("researchSources.title")}</h3>
					<Badge className="bg-blue-100 text-blue-800 text-[10px] border-0">
						{totalCount} sources
					</Badge>
				</div>

				<div className="space-y-2">
					{CATEGORY_ORDER.map((key) => {
						const data = parsed[key];
						if (!data) return null;

						const isRakuten = key === "rakuten_ranking";
						const isExpanded = expanded.has(key);
						const count = Array.isArray(data) ? data.length : 1;

						return (
							<div key={key} className="border border-gray-100 rounded-xl overflow-hidden">
								<button
									type="button"
									onClick={() => toggleCategory(key)}
									className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50/50 transition-colors"
								>
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium text-gray-700">
											{t(`researchSources.categories.${key}` as Parameters<typeof t>[0])}
										</span>
										<Badge variant="outline" className="text-[10px] text-gray-500">
											{count}
										</Badge>
									</div>
									{isExpanded ? (
										<ChevronUp size={14} className="text-gray-400" />
									) : (
										<ChevronDown size={14} className="text-gray-400" />
									)}
								</button>

								{isExpanded && (
									<div className="px-4 pb-4 bg-gray-50/50">
										{isRakuten ? (
											<div className="text-xs text-gray-600 whitespace-pre-wrap font-mono leading-relaxed bg-white rounded-lg p-3 border border-gray-100">
												{data as string}
											</div>
										) : (
											<div className="space-y-2">
												{(data as ParsedSource[]).map((source, i) => (
													<div key={i} className="bg-white rounded-lg p-3 border border-gray-100">
														<a
															href={source.url}
															target="_blank"
															rel="noopener noreferrer"
															className="text-xs font-medium text-blue-600 hover:underline flex items-center gap-1"
														>
															{source.title || source.url}
															<ExternalLink size={10} />
														</a>
														{source.snippet && (
															<p className="text-[11px] text-gray-500 mt-1 leading-relaxed">
																{source.snippet}
															</p>
														)}
													</div>
												))}
											</div>
										)}
									</div>
								)}
							</div>
						);
					})}
				</div>
			</CardContent>
		</Card>
	);
}
