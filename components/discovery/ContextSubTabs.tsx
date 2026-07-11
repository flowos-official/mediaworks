"use client";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Home, Tv, Calendar, BarChart3 } from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";

type SubTab = "home" | "live" | "history" | "insights";

const TABS: Array<{ key: SubTab; icon: React.ReactNode; labelKey: "subTabHome" | "subTabLive" | "subTabHistory" | "subTabInsights" }> = [
	{ key: "home", icon: <Home size={14} />, labelKey: "subTabHome" },
	{ key: "live", icon: <Tv size={14} />, labelKey: "subTabLive" },
	{ key: "history", icon: <Calendar size={14} />, labelKey: "subTabHistory" },
	{ key: "insights", icon: <BarChart3 size={14} />, labelKey: "subTabInsights" },
];

export function ContextSubTabs() {
	const t = useTranslations("discovery");
	const { locale } = useParams<{ locale: string }>();
	const pathname = usePathname();

	const activeTab = (() => {
		const parts = pathname.split("/").filter(Boolean);
		const idx = parts.indexOf("discovery");
		const sub = idx >= 0 ? parts[idx + 1] : undefined;
		if (sub === "home" || sub === "live" || sub === "history" || sub === "insights") return sub;
		return "home";
	})();

	return (
		<nav aria-label="Discovery views" className="mw-scrollbar flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 shadow-sm">
			{TABS.map((tab) => {
				const href = localePath(locale, `/analytics/discovery/${tab.key}`);
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
						{tab.icon}
						{t(tab.labelKey)}
					</Link>
				);
			})}
		</nav>
	);
}
