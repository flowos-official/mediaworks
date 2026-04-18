"use client";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { KPICard } from "./KPICard";
import { WeeklyInsightCard } from "./WeeklyInsightCard";
import { CategorySourcingChart } from "./charts/CategorySourcingChart";
import { DailyFeedbackChart } from "./charts/DailyFeedbackChart";
import { ExplorationTrendChart } from "./charts/ExplorationTrendChart";
import { RejectionReasonChart } from "./charts/RejectionReasonChart";

interface InsightsData {
	kpi: {
		thisWeekSourced: number;
		thisWeekRejected: number;
		explorationRatio: number;
		totalSamples: number;
	};
	weeklyInsights: Array<{
		week_start: string;
		context: "home_shopping" | "live_commerce";
		sourced_product_patterns: string | null;
		exploration_wins: string | null;
		next_week_suggestions: string | null;
		sourced_count: number | null;
		rejected_count: number | null;
	}>;
	categoryWeights: Record<string, number>;
	explorationTrend: Array<{ week: string; home: number; live: number }>;
	rejectionReasons: Array<{ reason: string; count: number }>;
	dailyFeedback: Array<{
		date: string;
		sourced: number;
		interested: number;
		rejected: number;
		duplicate: number;
	}>;
}

export function StatsDashboard() {
	const t = useTranslations("discovery");
	const [data, setData] = useState<InsightsData | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		fetch("/api/discovery/insights?weeks=12")
			.then((r) => r.json())
			.then((d) => {
				setData(d);
				setLoading(false);
			})
			.catch(() => setLoading(false));
	}, []);

	if (loading) return <div className="py-20 text-center text-sm text-gray-500">Loading...</div>;
	if (!data) return <div className="py-20 text-center text-sm text-gray-400">{t("noData")}</div>;

	const categoryData = Object.entries(data.categoryWeights).map(([category, rate]) => ({
		category,
		sourced: 0,
		shown: 0,
		rate,
	}));

	const latestInsight = data.weeklyInsights[0] ?? null;

	return (
		<div className="space-y-6">
			<div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
				<KPICard
					label={t("kpiSourcedThisWeek")}
					value={data.kpi.thisWeekSourced}
					subtitle={t("thisWeek")}
					accent="green"
				/>
				<KPICard
					label={t("kpiRejectedThisWeek")}
					value={data.kpi.thisWeekRejected}
					subtitle={t("thisWeek")}
					accent="red"
				/>
				<KPICard
					label={t("kpiExplorationRatio")}
					value={`${Math.round(data.kpi.explorationRatio * 100)}%`}
					accent="blue"
				/>
				<KPICard
					label={t("kpiTotalSamples")}
					value={data.kpi.totalSamples}
					subtitle={t("cumulative")}
					accent="gray"
				/>
			</div>

			<WeeklyInsightCard insight={latestInsight} />

			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
				<ChartCard title={t("chartCategorySourcing")}>
					<CategorySourcingChart data={categoryData} />
				</ChartCard>
				<ChartCard title={t("chartDailyFeedback")}>
					<DailyFeedbackChart data={data.dailyFeedback} />
				</ChartCard>
				<ChartCard title={t("chartExplorationTrend")}>
					<ExplorationTrendChart data={data.explorationTrend} />
				</ChartCard>
				<ChartCard title={t("chartRejectionReasons")}>
					<RejectionReasonChart data={data.rejectionReasons} />
				</ChartCard>
			</div>
		</div>
	);
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="bg-white border border-gray-200 rounded-lg p-4">
			<h4 className="text-sm font-semibold text-gray-900 mb-3">{title}</h4>
			{children}
		</div>
	);
}
