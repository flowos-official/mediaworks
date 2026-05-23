"use client";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { Activity, Radio, TrendingUp } from "lucide-react";
import { useTranslations } from "next-intl";
import { localePath } from "@/lib/i18n/locale-path";
import {
	getStrategyActiveTab,
	STRATEGY_SUB_TABS,
	type StrategySubTabKey,
} from "@/lib/nav/strategy-subtabs";

const TAB_ICONS: Record<StrategySubTabKey, React.ReactNode> = {
	expansion: <TrendingUp size={14} />,
	live: <Radio size={14} />,
	status: <Activity size={14} />,
};

export function StrategySubTabs() {
	const { locale } = useParams<{ locale: string }>();
	const pathname = usePathname();
	const t = useTranslations("nav");
	const activeTab = getStrategyActiveTab(pathname);

	return (
		<div className="flex gap-1 p-1 bg-card border border-border rounded-lg shadow-sm mb-4 w-fit">
			{STRATEGY_SUB_TABS.map((tab) => {
				const href = localePath(locale, tab.href);
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
						{TAB_ICONS[tab.key]}
						{t(tab.labelKey)}
					</Link>
				);
			})}
		</div>
	);
}
