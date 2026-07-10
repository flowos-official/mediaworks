import type { ScriptCheckResult, Severity } from "./compliance/types";
import type { ScreenplayRow } from "./types";

export type BroadcastReadiness =
	| "generating"
	| "failed"
	| "draft"
	| "blocked"
	| "review"
	| "ready";

export interface ReadinessSummary {
	state: BroadcastReadiness;
	high: number;
	medium: number;
	low: number;
	total: number;
	referenceCount: number;
	factSearchRan: boolean;
}

function countSeverity(check: ScriptCheckResult, severity: Severity): number {
	return [...check.legal, ...check.facts, ...check.quality].filter(
		(finding) => finding.severity === severity,
	).length;
}

export function summarizeReadiness(
	status: ScreenplayRow["status"],
	check: ScriptCheckResult | null | undefined,
): ReadinessSummary {
	if (status === "generating") {
		return {
			state: "generating",
			high: 0,
			medium: 0,
			low: 0,
			total: 0,
			referenceCount: 0,
			factSearchRan: false,
		};
	}
	if (status === "failed") {
		return {
			state: "failed",
			high: 0,
			medium: 0,
			low: 0,
			total: 0,
			referenceCount: 0,
			factSearchRan: false,
		};
	}
	if (!check) {
		return {
			state: "draft",
			high: 0,
			medium: 0,
			low: 0,
			total: 0,
			referenceCount: 0,
			factSearchRan: false,
		};
	}

	const high = countSeverity(check, "high");
	const medium = countSeverity(check, "med");
	const low = countSeverity(check, "low");
	const total = high + medium + low;
	return {
		state: high > 0 ? "blocked" : total > 0 ? "review" : "ready",
		high,
		medium,
		low,
		total,
		referenceCount: check.grounding?.referencesSnapshot?.length ?? 0,
		factSearchRan: check.grounding?.factSearch ?? false,
	};
}

export const READINESS_LABEL_JA: Record<BroadcastReadiness, string> = {
	generating: "生成中",
	failed: "生成失敗",
	draft: "下書き・未チェック",
	blocked: "放送不可・要修正",
	review: "要レビュー",
	ready: "人による承認待ち",
};

