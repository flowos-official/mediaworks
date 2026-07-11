"use client";

import { ContextSubTabs } from "@/components/discovery/ContextSubTabs";
import { InsightsTabs } from "@/components/discovery/InsightsTabs";

export default function InsightsPage() {
	return (
		<div className="space-y-4">
			<ContextSubTabs />
			<InsightsTabs />
		</div>
	);
}
