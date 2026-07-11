import { useTranslations } from "next-intl";

type Session = {
	id: string;
	run_at: string;
	completed_at: string | null;
	status: "running" | "completed" | "partial" | "failed";
	target_count: number;
	produced_count: number;
	iterations: number;
};

export function DiscoveryHeader({
	session,
	totalCount,
	uncategorizedCount,
	sourcedCount,
}: {
	session: Session | null;
	totalCount: number;
	uncategorizedCount: number;
	sourcedCount: number;
}) {
	const t = useTranslations("discovery");

	if (!session) {
		return (
			<div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200">
				{t("noSession")}
			</div>
		);
	}

	const statusColor =
		session.status === "completed"
			? "bg-green-600/10 text-green-700 dark:text-green-300 border-green-200 dark:border-green-900/40"
			: session.status === "partial"
			? "bg-yellow-600/10 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-900/40"
			: session.status === "failed"
			? "bg-red-600/10 text-red-700 dark:text-red-300 border-red-200 dark:border-red-900/40"
			: "bg-blue-600/10 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-900/40";

	const statusLabel =
		session.status === "completed"
			? t("sessionCompleted")
			: session.status === "partial"
			? t("sessionPartial")
			: session.status === "failed"
			? t("sessionFailed")
			: t("sessionRunning");

	return (
		<div className="mw-panel mb-4 flex flex-wrap items-center gap-3 px-4 py-3">
			<div className="mr-1">
				<div className="mw-kicker">Latest discovery run</div>
				<span className="font-mono text-[10px] text-muted-foreground">
					{new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(session.run_at))}
				</span>
			</div>
			<span className={`inline-flex items-center rounded-md border px-2.5 py-1 font-mono text-[10px] font-semibold ${statusColor}`}>
				{statusLabel}
			</span>
			<span className="font-mono text-sm font-semibold tabular-nums text-foreground">
				{totalCount}/{session.target_count} 件
			</span>
			<div className="flex gap-2 text-[10px]">
				<span className="rounded-md bg-muted px-2 py-1 text-muted-foreground">
					{t("filterUncategorized")}: <strong>{uncategorizedCount}</strong>
				</span>
				<span className="rounded-md bg-emerald-600/12 px-2 py-1 text-emerald-700 dark:text-emerald-300">
					{t("filterSourced")}: <strong>{sourcedCount}</strong>
				</span>
			</div>
			{session.iterations > 0 && (
				<span className="ml-auto font-mono text-[10px] text-muted-foreground">iter: {session.iterations}</span>
			)}
		</div>
	);
}
