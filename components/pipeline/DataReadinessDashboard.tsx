import type { IntelligenceReadiness, ReadinessStatus } from "@/lib/intelligence/readiness";

export interface ReadinessDashboardCopy {
	title: string;
	description: string;
	sources: string;
	coverage: string;
	categories: string;
	failures: string;
	noFailures: string;
	notRequestedIsNormal: string;
	generatedAt: string;
	latestAttempt: string;
	latestSuccess: string;
	sourceDetail: string;
	statusLabel: string;
	status: Record<ReadinessStatus, string>;
	metric: {
		canonicalLink: string;
		category: string;
		broadcastAnalysis: string;
		evidence: string;
		insights: string;
	};
	categoryColumns: {
		category: string;
		analyzed: string;
		total: string;
		coverage: string;
	};
	noCategories: string;
	failureColumns: {
		source: string;
		startedAt: string;
		errorCode: string;
		errorSummary: string;
	};
	noData: string;
	sourcesByKey: Record<string, string>;
}

interface DataReadinessDashboardProps {
	readiness: IntelligenceReadiness;
	copy: ReadinessDashboardCopy;
	locale: string;
}

type CategorySample = IntelligenceReadiness["categorySamples"][number];

const STATUS_CLASS: Record<ReadinessStatus, string> = {
	healthy: "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-300",
	stale: "border-amber-600/30 bg-amber-600/10 text-amber-700 dark:text-amber-300",
	failed: "border-red-600/30 bg-red-600/10 text-red-700 dark:text-red-300",
	missing: "border-border bg-muted text-muted-foreground",
};

function isFinitePercentage(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

export function sortReadinessCategorySamples(samples: readonly CategorySample[]): CategorySample[] {
	return [...samples].sort((left, right) => {
		const leftPct = left.pct;
		const rightPct = right.pct;
		const leftFinite = isFinitePercentage(leftPct);
		const rightFinite = isFinitePercentage(rightPct);
		if (leftFinite !== rightFinite) return leftFinite ? 1 : -1;
		if (leftFinite && rightFinite && leftPct !== rightPct) return leftPct - rightPct;
		return left.category < right.category ? -1 : left.category > right.category ? 1 : 0;
	});
}

function formatPercent(value: unknown, noData: string): string {
	return isFinitePercentage(value) ? `${value}%` : noData;
}

function formatDate(value: string | null, formatter: Intl.DateTimeFormat, noData: string): string {
	if (!value || !Number.isFinite(Date.parse(value))) return noData;
	return formatter.format(new Date(value));
}

function textOrNoData(value: string | null | undefined, noData: string): string {
	return value?.trim() || noData;
}

function MetricCard({
	metricKey,
	label,
	value,
	detail,
}: {
	metricKey: string;
	label: string;
	value: string;
	detail: string;
}) {
	return (
		<article data-readiness-metric={metricKey} className="mw-panel min-w-0 p-3">
			<h4 className="text-xs font-medium text-muted-foreground">{label}</h4>
			<div data-readiness-metric-value className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
			<p className="mt-1 text-xs tabular-nums text-muted-foreground">{detail}</p>
		</article>
	);
}

export function DataReadinessDashboard({ readiness, copy, locale }: DataReadinessDashboardProps) {
	const intlLocale = locale === "ko" ? "ko-KR" : "ja-JP";
	const dateFormatter = new Intl.DateTimeFormat(intlLocale, {
		timeZone: "Asia/Tokyo",
		dateStyle: "medium",
		timeStyle: "short",
	});
	const numberFormatter = new Intl.NumberFormat(intlLocale);
	const formatNumber = (value: number) => numberFormatter.format(value);
	const categories = sortReadinessCategorySamples(readiness.categorySamples);
	const metrics = [
		{
			key: "canonical-link",
			label: copy.metric.canonicalLink,
			value: formatPercent(readiness.coverage.canonicalLinkPct, copy.noData),
			detail: `${formatNumber(readiness.coverage.canonicalLinked)} / ${formatNumber(readiness.coverage.activeProducts)}`,
		},
		{
			key: "category",
			label: copy.metric.category,
			value: formatPercent(readiness.coverage.categoryPct, copy.noData),
			detail: `${formatNumber(readiness.coverage.categorizedActive)} / ${formatNumber(readiness.coverage.activeProducts)}`,
		},
		{
			key: "broadcast-analysis",
			label: copy.metric.broadcastAnalysis,
			value: formatPercent(readiness.coverage.analysisPct, copy.noData),
			detail: `${formatNumber(readiness.coverage.analyzedBroadcasts)} / ${formatNumber(readiness.coverage.archivedBroadcasts)}`,
		},
		{
			key: "evidence",
			label: copy.metric.evidence,
			value: formatNumber(readiness.coverage.evidenceItems),
			detail: copy.metric.evidence,
		},
		{
			key: "insights",
			label: copy.metric.insights,
			value: formatNumber(readiness.coverage.insightSnapshots),
			detail: copy.metric.insights,
		},
	];

	return (
		<article className="space-y-5" aria-labelledby="data-readiness-title">
			<header className="mw-panel px-4 py-4 sm:px-5">
				<div className="mw-kicker mb-1">{copy.title}</div>
				<h2 id="data-readiness-title" className="text-xl font-bold tracking-[-0.02em] text-foreground">
					{copy.title}
				</h2>
				<p className="mt-1 text-xs text-muted-foreground sm:text-sm">{copy.description}</p>
				<p className="mt-2 text-xs tabular-nums text-muted-foreground">
					{copy.generatedAt}: {formatDate(readiness.generatedAt, dateFormatter, copy.noData)}
				</p>
			</header>

			<section aria-labelledby="data-readiness-sources-title">
				<h3 id="data-readiness-sources-title" className="mw-section-title mb-2">
					{copy.sources}
				</h3>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
					{readiness.sources.map((source) => {
						const statusText = copy.status[source.status];
						return (
							<article key={source.key} className="mw-panel min-w-0 p-3">
								<div className="flex items-start justify-between gap-2">
									<h4 className="min-w-0 text-sm font-semibold text-foreground">
										{copy.sourcesByKey[source.key] ?? source.key}
									</h4>
									<span
										aria-label={`${copy.statusLabel}: ${statusText}`}
										className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_CLASS[source.status]}`}
									>
										{statusText}
									</span>
								</div>
								<dl className="mt-3 space-y-1.5 text-xs">
									<div className="flex items-baseline justify-between gap-3">
										<dt className="text-muted-foreground">{copy.latestAttempt}</dt>
										<dd className="shrink-0 tabular-nums text-foreground">
											{formatDate(source.latestAttemptAt, dateFormatter, copy.noData)}
										</dd>
									</div>
									<div className="flex items-baseline justify-between gap-3">
										<dt className="text-muted-foreground">{copy.latestSuccess}</dt>
										<dd className="shrink-0 tabular-nums text-foreground">
											{formatDate(source.latestSuccessAt, dateFormatter, copy.noData)}
										</dd>
									</div>
								</dl>
								<dl className="mt-2 border-t border-border pt-2 text-xs">
									<div className="space-y-0.5">
										<dt className="text-muted-foreground">{copy.sourceDetail}</dt>
										<dd data-readiness-source-detail className="break-words text-foreground">
											{textOrNoData(source.detail, copy.noData)}
										</dd>
									</div>
								</dl>
							</article>
						);
					})}
				</div>
			</section>

			<section aria-labelledby="data-readiness-coverage-title">
				<h3 id="data-readiness-coverage-title" className="mw-section-title mb-2">
					{copy.coverage}
				</h3>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
					{metrics.map(({ key, ...metric }) => (
						<MetricCard key={key} metricKey={key} {...metric} />
					))}
				</div>
			</section>

			<section aria-labelledby="data-readiness-categories-title">
				<h3 id="data-readiness-categories-title" className="mw-section-title mb-2">
					{copy.categories}
				</h3>
				{categories.length === 0 ? (
					<p className="mw-panel px-4 py-3 text-sm text-muted-foreground">{copy.noCategories}</p>
				) : (
					<div className="mw-table-shell overflow-x-auto">
						<table className="min-w-[560px] w-full text-sm">
							<caption className="sr-only">{copy.categories}</caption>
							<thead className="bg-muted text-xs text-muted-foreground">
								<tr>
									<th scope="col" className="px-3 py-2 text-left font-medium">{copy.categoryColumns.category}</th>
									<th scope="col" className="px-3 py-2 text-right font-medium">{copy.categoryColumns.analyzed}</th>
									<th scope="col" className="px-3 py-2 text-right font-medium">{copy.categoryColumns.total}</th>
									<th scope="col" className="px-3 py-2 text-right font-medium">{copy.categoryColumns.coverage}</th>
								</tr>
							</thead>
							<tbody>
								{categories.map((sample) => (
									<tr key={sample.category} data-readiness-category={sample.category} className="border-t border-border">
										<td className="px-3 py-2 font-medium text-foreground">{sample.category}</td>
										<td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-foreground">{formatNumber(sample.analyzed)}</td>
										<td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">{formatNumber(sample.total)}</td>
										<td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-foreground">{formatPercent(sample.pct, copy.noData)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			<section aria-labelledby="data-readiness-failures-title">
				<h3 id="data-readiness-failures-title" className="mw-section-title mb-2">
					{copy.failures}
				</h3>
				{readiness.failures.length === 0 ? (
					<p className="mw-panel px-4 py-3 text-sm text-muted-foreground">{copy.noFailures}</p>
				) : (
					<div className="mw-table-shell overflow-x-auto">
						<table className="min-w-[680px] w-full text-sm">
							<caption className="sr-only">{copy.failures}</caption>
							<thead className="bg-muted text-xs text-muted-foreground">
								<tr>
									<th scope="col" className="px-3 py-2 text-left font-medium">{copy.failureColumns.source}</th>
									<th scope="col" className="px-3 py-2 text-left font-medium">{copy.failureColumns.startedAt}</th>
									<th scope="col" className="px-3 py-2 text-left font-medium">{copy.failureColumns.errorCode}</th>
									<th scope="col" className="px-3 py-2 text-left font-medium">{copy.failureColumns.errorSummary}</th>
								</tr>
							</thead>
							<tbody>
								{readiness.failures.map((failure) => (
									<tr key={`${failure.sourceType}:${failure.jobType}:${failure.startedAt}`} className="border-t border-border">
										<td className="px-3 py-2 font-mono text-xs text-foreground">{failure.sourceType}/{failure.jobType}</td>
										<td className="whitespace-nowrap px-3 py-2 font-mono text-xs tabular-nums text-muted-foreground">
											{formatDate(failure.startedAt, dateFormatter, copy.noData)}
										</td>
										<td data-readiness-failure-code className="px-3 py-2 font-mono text-xs text-foreground">
											{textOrNoData(failure.errorCode, copy.noData)}
										</td>
										<td data-readiness-failure-summary className="px-3 py-2 text-xs text-foreground">
											{textOrNoData(failure.errorSummary, copy.noData)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>

			<p className="rounded-xl border border-primary/20 bg-primary/[0.04] px-4 py-3 text-sm text-muted-foreground">
				{copy.notRequestedIsNormal}
			</p>
		</article>
	);
}
