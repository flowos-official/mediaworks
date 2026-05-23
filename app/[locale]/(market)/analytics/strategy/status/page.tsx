import { RecommendationFlowStatusPanel } from "@/components/analytics/RecommendationFlowStatusPanel";
import { StrategySubTabs } from "@/components/analytics/StrategySubTabs";

export default function RecommendationFlowStatusPage() {
	return (
		<>
			<StrategySubTabs />
			<RecommendationFlowStatusPanel />
		</>
	);
}
