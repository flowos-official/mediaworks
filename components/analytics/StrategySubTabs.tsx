"use client";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { TrendingUp, Radio } from "lucide-react";

type SubTab = "expansion" | "live";

const TABS: Array<{ key: SubTab; icon: React.ReactNode; label: string }> = [
	{ key: "expansion", icon: <TrendingUp size={14} />, label: "拡大戦略" },
	{ key: "live", icon: <Radio size={14} />, label: "ライブコマース戦略" },
];

export function StrategySubTabs() {
	const { locale } = useParams<{ locale: string }>();
	const pathname = usePathname();

	const activeTab = (() => {
		const parts = pathname.split("/").filter(Boolean);
		const sub = parts[3];
		if (sub === "expansion" || sub === "live") return sub;
		return "expansion";
	})();

	return (
		<div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-lg shadow-sm mb-4 w-fit">
			{TABS.map((tab) => {
				const href = `/${locale}/analytics/strategy/${tab.key}`;
				const active = activeTab === tab.key;
				return (
					<Link
						key={tab.key}
						href={href}
						className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
							active
								? "bg-indigo-500 text-white shadow-sm"
								: "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
						}`}
					>
						{tab.icon}
						{tab.label}
					</Link>
				);
			})}
		</div>
	);
}
