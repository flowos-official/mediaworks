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
		<div className="bg-white border border-gray-200 rounded-lg px-4 py-3 mb-4 flex flex-wrap items-center gap-3">
			<span className={`inline-flex items-center px-3 py-1 rounded-full border text-xs font-medium ${statusColor}`}>
				{statusLabel}
			</span>
			<span className="text-sm text-gray-600">
				{new Date(session.run_at).toLocaleString("ja-JP")}
			</span>
			<span className="text-sm text-gray-900 font-medium">
				{totalCount}/{session.target_count} 件
			</span>
			<div className="flex gap-2 text-xs">
				<span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600">
					{t("filterUncategorized")}: <strong>{uncategorizedCount}</strong>
				</span>
				<span className="px-2 py-0.5 rounded bg-green-100 text-green-700">
					{t("filterSourced")}: <strong>{sourcedCount}</strong>
				</span>
			</div>
			{session.iterations > 0 && (
				<span className="text-xs text-gray-400 ml-auto">iter: {session.iterations}</span>
			)}
		</div>
	);
}
