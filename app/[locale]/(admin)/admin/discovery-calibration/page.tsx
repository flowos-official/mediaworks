import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/require-user";
import { localePath } from "@/lib/i18n/locale-path";

export const dynamic = "force-dynamic";

interface PageProps {
	params: Promise<{ locale: string }>;
}

interface CalRow {
	context: string;
	score_band: number;
	shown: number;
	selected_plus: number;
	sourced_plus: number;
	scheduled_plus: number;
	aired: number;
	dropped: number;
}

const BAND_LABEL: Record<number, string> = {
	0: "<40",
	1: "40–59",
	2: "60–74",
	3: "≥75",
};
const MIN_BAND_SAMPLE = 5; // mirrors CATEGORY_MIN_SAMPLES; suppress % when the band has too few selections

// Conversion rate as a % of `shown`, suppressed for bands with fewer than
// MIN_BAND_SAMPLE selections (selected_plus) — matches the caption + spec §4 D-4.
function pct(numer: number, denom: number, selectedPlus: number): string {
	if (selectedPlus < MIN_BAND_SAMPLE || denom <= 0) return "—";
	return `${Math.round((numer / denom) * 100)}%`;
}

export default async function DiscoveryCalibrationPage({ params }: PageProps) {
	const { locale } = await params;
	const auth = await requireUser(["admin"]);
	if ("error" in auth) redirect(localePath(locale, "/login"));
	const sb = auth.sb;

	const { data, error } = await sb
		.from("discovery_score_calibration")
		.select("context, score_band, shown, selected_plus, sourced_plus, scheduled_plus, aired, dropped")
		.order("context", { ascending: true })
		.order("score_band", { ascending: false });

	const rows = (data ?? []) as CalRow[];
	const byContext = new Map<string, CalRow[]>();
	for (const r of rows) {
		const list = byContext.get(r.context) ?? [];
		list.push(r);
		byContext.set(r.context, list);
	}

	return (
		<div className="max-w-5xl mx-auto p-6">
			<h1 className="text-2xl font-semibold mb-2">Discovery Score Calibration</h1>
			<p className="text-sm text-muted-foreground mb-6">
				Conversion rate by <code>tv_fit_score</code> band over the last 90 days. A
				higher band should convert better — a flat curve means the score is not
				predictive. <strong>aired</strong> lags discovery by weeks–months, so a low
				<code> aired</code> in recent data is expected, not evidence of a bad score.
				Conversion % is hidden for bands with fewer than {MIN_BAND_SAMPLE} selections.
			</p>

			{error ? (
				<p className="text-sm text-red-600">View query failed: {error.message}</p>
			) : byContext.size === 0 ? (
				<p className="text-sm text-muted-foreground">No data yet.</p>
			) : (
				[...byContext.entries()].map(([context, list]) => (
					<div key={context} className="mb-8">
						<h2 className="text-lg font-semibold mb-2">{context}</h2>
						<table className="w-full text-sm">
							<thead className="bg-muted border-b">
								<tr>
									<th className="text-left px-3 py-2">Score band</th>
									<th className="text-right px-3 py-2">Shown</th>
									<th className="text-right px-3 py-2">Selected+</th>
									<th className="text-right px-3 py-2">Sourced+</th>
									<th className="text-right px-3 py-2">Scheduled+</th>
									<th className="text-right px-3 py-2">Aired</th>
									<th className="text-right px-3 py-2">Dropped</th>
								</tr>
							</thead>
							<tbody>
								{list.map((r) => (
									<tr key={`${r.context}-${r.score_band}`} className="border-b">
										<td className="px-3 py-2 font-medium">{BAND_LABEL[r.score_band] ?? r.score_band}</td>
										<td className="px-3 py-2 text-right">{r.shown.toLocaleString("ja-JP")}</td>
										<td className="px-3 py-2 text-right">{r.selected_plus} <span className="text-muted-foreground">({pct(r.selected_plus, r.shown, r.selected_plus)})</span></td>
										<td className="px-3 py-2 text-right">{r.sourced_plus} <span className="text-muted-foreground">({pct(r.sourced_plus, r.shown, r.selected_plus)})</span></td>
										<td className="px-3 py-2 text-right">{r.scheduled_plus} <span className="text-muted-foreground">({pct(r.scheduled_plus, r.shown, r.selected_plus)})</span></td>
										<td className="px-3 py-2 text-right">{r.aired} <span className="text-muted-foreground">({pct(r.aired, r.shown, r.selected_plus)})</span></td>
										<td className="px-3 py-2 text-right text-muted-foreground">{r.dropped}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				))
			)}
		</div>
	);
}
