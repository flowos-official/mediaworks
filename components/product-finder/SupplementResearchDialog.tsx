"use client";

/**
 * Ask before spending money and touching the internet.
 *
 * Everything else on this surface reads stored data and costs nothing. This
 * dialog is the one place that leaves the building, so it is built to make
 * that impossible to do by accident:
 *
 *   Opening it makes no request. The dialog is a description of what WOULD
 *   happen, not the start of it.
 *
 *   The gaps are checkboxes over the five allowed values, preselected from the
 *   item's own missing data. An operator can only ask for something we are
 *   prepared to classify honestly.
 *
 *   Running takes a second, separate confirmation. One click opens the dialog;
 *   the second states what will be searched; the third runs it.
 *
 *   The rules about what a result can become are stated BEFORE execution, not
 *   discovered afterwards in a badge.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { SUPPLEMENT_GAPS, type SupplementGap } from "@/lib/intelligence/supplement/types";

/** Which gap a piece of missing data corresponds to. The fact pack names gaps
 *  in Japanese prose, so the mapping lives here rather than being parsed. */
const GAP_FOR_MISSING: Record<string, SupplementGap> = {
	price: "current_price",
	price_jpy: "current_price",
	review_count: "review_signal",
	tv_airing_count: "ranking_signal",
	market_demand: "review_signal",
	company_fit: "official_product_facts",
	competition_headroom: "ranking_signal",
	broadcast_fit: "ranking_signal",
	profitability: "official_product_facts",
};

export interface SupplementSuccess {
	recommendationRunId: string;
	status: "completed" | "partial";
	evidenceCount: number;
	failedGaps: SupplementGap[];
}

export function preselectedGaps(missingData: readonly string[]): SupplementGap[] {
	const gaps = new Set<SupplementGap>();
	for (const missing of missingData) {
		for (const [key, gap] of Object.entries(GAP_FOR_MISSING)) {
			if (missing.includes(key)) gaps.add(gap);
		}
	}
	// Nothing matched: offer the cheapest useful default rather than an empty
	// form the operator has to guess their way through.
	if (gaps.size === 0) gaps.add("current_price");
	return SUPPLEMENT_GAPS.filter((gap) => gaps.has(gap));
}

export function SupplementResearchDialog({
	runId,
	canonicalProductId,
	productName,
	missingData,
	onClose,
	onSuccess,
}: {
	runId: string;
	canonicalProductId: string;
	productName: string;
	missingData: string[];
	onClose: () => void;
	onSuccess: (result: SupplementSuccess) => void;
}) {
	const t = useTranslations("productFinder.supplement");
	const [selected, setSelected] = useState<SupplementGap[]>(() => preselectedGaps(missingData));
	const [confirming, setConfirming] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	function toggle(gap: SupplementGap) {
		setConfirming(false);
		setSelected((current) =>
			current.includes(gap) ? current.filter((g) => g !== gap) : [...current, gap],
		);
	}

	async function run() {
		if (selected.length === 0) return;
		setPending(true);
		setError(null);
		try {
			const res = await fetch(`/api/product-finder/runs/${runId}/supplement`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ canonicalProductId, gaps: selected }),
			});
			const payload = (await res.json()) as {
				recommendationRunId?: string;
				status?: string;
				evidenceCount?: number;
				failedGaps?: SupplementGap[];
				message?: string;
			};
			if (!res.ok || !payload.recommendationRunId || payload.status === "failed") {
				// The original run is still the operator's best result, and the
				// service returns its id even here — so nothing is lost.
				setError(t("failed"));
				return;
			}
			onSuccess({
				recommendationRunId: payload.recommendationRunId,
				status: payload.status === "partial" ? "partial" : "completed",
				evidenceCount: payload.evidenceCount ?? 0,
				failedGaps: payload.failedGaps ?? [],
			});
		} catch {
			setError(t("failed"));
		} finally {
			setPending(false);
		}
	}

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label={t("title")}
			className="mt-3 space-y-3 rounded-lg border border-amber-500/50 bg-amber-50/50 p-3 dark:bg-amber-950/20"
		>
			<div>
				<h4 className="text-sm font-medium">{t("title")}</h4>
				<p className="text-xs text-muted-foreground">{t("subject", { name: productName })}</p>
			</div>

			{missingData.length > 0 ? (
				<div>
					<p className="text-xs font-medium text-muted-foreground">{t("missingHeading")}</p>
					<ul className="list-disc pl-4 text-xs text-muted-foreground">
						{missingData.map((missing) => (
							<li key={missing}>{missing}</li>
						))}
					</ul>
				</div>
			) : null}

			<fieldset className="space-y-1">
				<legend className="text-xs font-medium text-muted-foreground">{t("gapsHeading")}</legend>
				{SUPPLEMENT_GAPS.map((gap) => (
					<label key={gap} className="flex items-start gap-2 text-sm">
						<input
							type="checkbox"
							className="mt-1"
							checked={selected.includes(gap)}
							onChange={() => toggle(gap)}
							disabled={pending}
						/>
						<span>
							{t(`gap.${gap}`)}
							<span className="block text-xs text-muted-foreground">{t(`gapClass.${gap}`)}</span>
						</span>
					</label>
				))}
			</fieldset>

			{/* Stated before execution. Discovering afterwards that a "10万台"
			    figure is stored as a claim is too late to be useful. */}
			<p className="rounded border border-dashed p-2 text-xs text-muted-foreground">
				{t("classRules")}
			</p>

			{error ? <p className="text-xs text-red-600">{error}</p> : null}

			<div className="flex flex-wrap items-center gap-2">
				{confirming ? (
					<>
						<p className="w-full text-xs font-medium text-amber-800 dark:text-amber-200">
							{t("confirmSentence", { count: selected.length })}
						</p>
						<button
							type="button"
							disabled={pending || selected.length === 0}
							onClick={() => void run()}
							className="rounded bg-amber-600 px-2.5 py-1 text-sm text-white disabled:opacity-50"
						>
							{pending ? t("running") : t("confirmRun")}
						</button>
					</>
				) : (
					<button
						type="button"
						disabled={selected.length === 0}
						onClick={() => setConfirming(true)}
						className="rounded border px-2.5 py-1 text-sm disabled:opacity-50"
					>
						{t("review")}
					</button>
				)}
				<button
					type="button"
					disabled={pending}
					onClick={onClose}
					className="rounded border px-2.5 py-1 text-sm"
				>
					{t("cancel")}
				</button>
			</div>
		</div>
	);
}
