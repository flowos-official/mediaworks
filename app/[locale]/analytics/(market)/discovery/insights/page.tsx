"use client";

import { ContextSubTabs } from "@/components/discovery/ContextSubTabs";
import { InsightsTabs } from "@/components/discovery/InsightsTabs";

export default function InsightsPage() {
	return (
		<div>
			<ContextSubTabs />
			<InsightsTabs />
		</div>
	);
}
