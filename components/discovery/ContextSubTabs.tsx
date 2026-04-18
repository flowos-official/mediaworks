"use client";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Home, Tv, Calendar } from "lucide-react";

type SubTab = "home" | "live" | "history";

const TABS: Array<{ key: SubTab; icon: React.ReactNode; labelKey: "subTabHome" | "subTabLive" | "subTabHistory" }> = [
	{ key: "home", icon: <Home size={14} />, labelKey: "subTabHome" },
	{ key: "live", icon: <Tv size={14} />, labelKey: "subTabLive" },
	{ key: "history", icon: <Calendar size={14} />, labelKey: "subTabHistory" },
];

export function ContextSubTabs() {
	const t = useTranslations("discovery");
	const { locale } = useParams<{ locale: string }>();
	const pathname = usePathname();

	const activeTab = (() => {
		const parts = pathname.split("/").filter(Boolean);
		const sub = parts[3];
		if (sub === "home" || sub === "live" || sub === "history") return sub;
		return "home";
	})();

	return (
		<div className="flex gap-1 p-1 bg-white border border-gray-200 rounded-lg shadow-sm mb-4 w-fit">
			{TABS.map((tab) => {
				const href = `/${locale}/analytics/discovery/${tab.key}`;
				const active = activeTab === tab.key;
				return (
					<Link
						key={tab.key}
						href={href}
						className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
							active
								? "bg-amber-500 text-white shadow-sm"
								: "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
						}`}
					>
						{tab.icon}
						{t(tab.labelKey)}
					</Link>
				);
			})}
		</div>
	);
}
