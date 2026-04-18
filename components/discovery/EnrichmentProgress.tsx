"use client";
import { useTranslations } from "next-intl";
import { Loader2, AlertTriangle, Sparkles } from "lucide-react";

type Status = "idle" | "queued" | "running" | "completed" | "failed";

export function EnrichmentProgress({
	status,
	onTrigger,
	onToggleDetails,
	hasPackage,
	showDetails,
	error,
}: {
	status: Status;
	onTrigger: () => void;
	onToggleDetails: () => void;
	hasPackage: boolean;
	showDetails: boolean;
	error?: string | null;
}) {
	const t = useTranslations("discovery");

	if (status === "queued" || status === "running") {
		return (
			<button
				type="button"
				disabled
				className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold rounded-lg"
			>
				<Loader2 size={12} className="animate-spin" />
				{t("deepDiveRunning")}
			</button>
		);
	}

	if (status === "failed") {
		return (
			<div className="space-y-1">
				<div className="flex items-center gap-1 text-[10px] text-red-600">
					<AlertTriangle size={10} />
					{t("deepDiveFailed")}
					{error && <span className="truncate max-w-[200px]" title={error}>({error.slice(0, 40)})</span>}
				</div>
				<button
					type="button"
					onClick={onTrigger}
					className="w-full px-4 py-2 bg-white hover:bg-amber-50 border border-amber-300 text-amber-800 text-xs font-semibold rounded-lg"
				>
					<Sparkles size={12} className="inline mr-1" />
					{t("deepDive")}
				</button>
			</div>
		);
	}

	if (status === "completed" && hasPackage) {
		return (
			<button
				type="button"
				onClick={onToggleDetails}
				className="w-full px-4 py-2 bg-blue-50 hover:bg-blue-100 border border-blue-200 text-blue-800 text-xs font-semibold rounded-lg"
			>
				{showDetails ? t("hideDetails") : t("viewDetails")}
			</button>
		);
	}

	// idle
	return (
		<button
			type="button"
			onClick={onTrigger}
			className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-800 text-xs font-semibold rounded-lg"
		>
			<Sparkles size={12} />
			{t("deepDive")}
		</button>
	);
}
