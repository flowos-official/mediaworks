import { stripLocale } from "@/lib/nav/groups";

export type StrategySubTabKey = "expansion" | "live" | "status";

export interface StrategySubTab {
	key: StrategySubTabKey;
	href: string;
	labelKey: string;
}

export const STRATEGY_SUB_TABS: readonly StrategySubTab[] = [
	{
		key: "expansion",
		href: "/analytics/strategy/expansion",
		labelKey: "strategyTabs.expansion",
	},
	{
		key: "live",
		href: "/analytics/strategy/live",
		labelKey: "strategyTabs.live",
	},
	{
		key: "status",
		href: "/analytics/strategy/status",
		labelKey: "strategyTabs.status",
	},
] as const;

export function getStrategyActiveTab(pathname: string): StrategySubTabKey {
	const parts = stripLocale(pathname).split("/").filter(Boolean);
	const sub = parts[2];
	if (sub === "expansion" || sub === "live" || sub === "status") return sub;
	return "expansion";
}
