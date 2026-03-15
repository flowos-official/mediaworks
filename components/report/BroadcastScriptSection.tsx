"use client";

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";

interface BroadcastScripts {
	sec30: string;
	sec60: string;
	min5: string;
}

interface BroadcastScriptSectionProps {
	scripts: BroadcastScripts;
}

const TABS = [
	{ key: "sec30" as const, label: "30초" },
	{ key: "sec60" as const, label: "60초" },
	{ key: "min5" as const, label: "5분" },
];

export default function BroadcastScriptSection({
	scripts,
}: BroadcastScriptSectionProps) {
	const [activeTab, setActiveTab] = useState<keyof BroadcastScripts>("sec30");

	if (!scripts) return null;

	return (
		<Card>
			<CardContent className="p-6">
				<h3 className="text-lg font-semibold text-gray-900 mb-4">
					방송 스크립트
				</h3>

				<div className="flex gap-2 mb-4">
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

				<div className="bg-gray-50 rounded-lg p-4">
					<p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">
						{scripts[activeTab] || "스크립트가 아직 생성되지 않았습니다."}
					</p>
				</div>
			</CardContent>
		</Card>
	);
}
