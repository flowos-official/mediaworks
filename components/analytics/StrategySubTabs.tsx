"use client";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { TrendingUp, Radio } from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";

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
		<div className="flex gap-1 p-1 bg-card border border-border rounded-lg shadow-sm mb-4 w-fit">
			{TABS.map((tab) => {
				const href = localePath(locale, `/analytics/strategy/${tab.key}`);
				const active = activeTab === tab.key;
				return (
					<Link
						key={tab.key}
						href={href}
						className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
							active
								? "bg-indigo-500 text-white shadow-sm"
								: "text-muted-foreground hover:text-foreground hover:bg-muted"
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
