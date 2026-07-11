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
		<nav aria-label="Strategy views" className="mw-scrollbar mb-4 flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 shadow-sm">
			{STRATEGY_SUB_TABS.map((tab) => {
				const href = localePath(locale, tab.href);
				const active = activeTab === tab.key;
				return (
					<Link
						key={tab.key}
						href={href}
						className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-all ${
							active
								? "bg-primary text-primary-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground hover:bg-muted"
						}`}
					>
						{TAB_ICONS[tab.key]}
						{t(tab.labelKey)}
					</Link>
				);
			})}
		</nav>
	);
}
