import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/require-user";
import { loadBaseline } from "@/lib/historical-crawl/runs";
import HistoricalCrawlDashboard from "@/components/admin/HistoricalCrawlDashboard";

interface PageProps {
	params: Promise<{ locale: string }>;
}

export default async function Page({ params }: PageProps) {
	const { locale } = await params;
	const auth = await requireUser(["admin"]);
	if ("error" in auth) {
		redirect(`/${locale}/login`);
	}

	const [{ data: runs }, baseline] = await Promise.all([
		auth.sb
			.from("historical_crawl_runs")
			.select(
				"id,run_at,completed_at,jst_date,status,total_rows,upserted,skipped_dup,channels,duration_ms,error",
			)
			.order("run_at", { ascending: false })
			.limit(30),
		loadBaseline(7, auth.sb),
	]);

	return (
		<main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
			<HistoricalCrawlDashboard
				initialRuns={
					(runs ?? []) as Parameters<
						typeof HistoricalCrawlDashboard
					>[0]["initialRuns"]
				}
				baseline={baseline}
			/>
		</main>
	);
}
