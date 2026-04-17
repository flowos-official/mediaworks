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
			<div className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-3 text-yellow-800 text-sm">
				{t("noSession")}
			</div>
		);
	}

	const statusColor =
		session.status === "completed"
			? "bg-green-50 text-green-700 border-green-200"
			: session.status === "partial"
			? "bg-yellow-50 text-yellow-700 border-yellow-200"
			: session.status === "failed"
			? "bg-red-50 text-red-700 border-red-200"
			: "bg-blue-50 text-blue-700 border-blue-200";

	const statusLabel =
		session.status === "completed"
			? t("sessionCompleted")
			: session.status === "partial"
			? t("sessionPartial")
			: session.status === "failed"
			? t("sessionFailed")
			: t("sessionRunning");

	return (
		<div className="flex flex-wrap items-center gap-3 mb-6">
			<span className={`inline-flex items-center px-3 py-1 rounded-full border text-xs font-medium ${statusColor}`}>
				{statusLabel}
			</span>
			<span className="text-sm text-gray-600">
				{new Date(session.run_at).toLocaleString("ja-JP")}
			</span>
			<span className="text-sm text-gray-500">
				{totalCount}/{session.target_count} 件
			</span>
			<span className="text-sm text-gray-500">· {t("filterUncategorized")}: {uncategorizedCount}</span>
			<span className="text-sm text-gray-500">· {t("filterSourced")}: {sourcedCount}</span>
			{session.iterations > 0 && (
				<span className="text-xs text-gray-400">iterations: {session.iterations}</span>
			)}
		</div>
	);
}
