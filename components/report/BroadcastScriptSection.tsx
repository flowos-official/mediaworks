"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Copy, Check } from "lucide-react";

interface BroadcastScripts {
	sec30: string;
	sec60: string;
	min5: string;
}

interface BroadcastScriptSectionProps {
	scripts: BroadcastScripts;
}

const TABS = [
	{ key: "sec30" as const, label: "30秒" },
	{ key: "sec60" as const, label: "60秒" },
	{ key: "min5" as const, label: "5分" },
];

export default function BroadcastScriptSection({
	scripts,
}: BroadcastScriptSectionProps) {
	const [activeTab, setActiveTab] = useState<keyof BroadcastScripts>("sec30");
	const [copied, setCopied] = useState(false);

	if (!scripts) return null;

	const handleCopy = async () => {
		const text = scripts[activeTab];
		if (!text) return;
		await navigator.clipboard.writeText(text);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<Card>
			<CardContent className="p-6">
				<h3 className="text-lg font-semibold text-gray-900 mb-4">
					放送スクリプト
				</h3>

				<div className="flex items-center justify-between mb-4" data-pdf-hide>
					<div className="flex gap-2">
						{TABS.map(({ key, label }) => (
							<button
								key={key}
								type="button"
								onClick={() => setActiveTab(key)}
								className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
									activeTab === key
										? "bg-blue-600 text-white"
										: "bg-gray-100 text-gray-600 hover:bg-gray-200"
								}`}
							>
								{label}
							</button>
						))}
					</div>

					<button
						type="button"
						onClick={handleCopy}
						className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
					>
						{copied ? (
							<>
								<Check size={14} className="text-green-600" />
								コピー済み
							</>
						) : (
							<>
								<Copy size={14} />
								コピー
							</>
						)}
					</button>
				</div>

				{TABS.map(({ key, label }) => (
					<div
						key={key}
						className={`bg-gray-50 rounded-lg p-4 ${activeTab !== key ? "hidden" : ""} ${key !== TABS[0].key ? "mt-3" : ""}`}
						data-pdf-tab={key}
					>
						<p className="hidden pdf-tab-label text-xs font-semibold text-blue-600 mb-2">
							【{label}スクリプト】
						</p>
						<p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
							{scripts[key] || "スクリプトがまだ生成されていません。"}
						</p>
					</div>
				))}
			</CardContent>
		</Card>
	);
}
