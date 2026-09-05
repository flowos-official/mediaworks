"use client";

/**
 * The only network call this screen makes is POST /api/product-finder.
 *
 * A 409 is surfaced with its own message rather than folded into the generic
 * failure: it means the request asked for external research, and the operator
 * needs to know it was refused rather than that something broke.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ProductFinderResult } from "@/lib/product-finder/types";
import { ProductFinderForm, type ProductFinderFormValues } from "./ProductFinderForm";
import { ProductFinderResultCard } from "./ProductFinderResultCard";
import type { SupplementSuccess } from "./SupplementResearchDialog";

export function ProductFinderClient() {
	const t = useTranslations("productFinder");
	const [pending, setPending] = useState(false);
	const [result, setResult] = useState<ProductFinderResult | null>(null);
	// The run the supplemented one replaced, kept so the operator can go back
	// and see what the research actually changed. Overwriting the original in
	// place would leave nothing to compare against.
	const [priorResult, setPriorResult] = useState<ProductFinderResult | null>(null);
	const [supplementNote, setSupplementNote] = useState<SupplementSuccess | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function run(values: ProductFinderFormValues) {
		setPending(true);
		setError(null);
		setPriorResult(null);
		setSupplementNote(null);
		try {
			const res = await fetch("/api/product-finder", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(values),
			});
			if (res.status === 409) {
				setError(t("errors.supplementRequired"));
				return;
			}
			if (!res.ok) {
				setError(t("errors.failed"));
				return;
			}
			setResult((await res.json()) as ProductFinderResult);
		} catch {
			setError(t("errors.failed"));
		} finally {
			setPending(false);
		}
	}

	async function showSupplemented(supplement: SupplementSuccess) {
		setError(null);
		try {
			const res = await fetch(`/api/product-finder/runs/${supplement.recommendationRunId}`);
			if (!res.ok) {
				setError(t("errors.failed"));
				return;
			}
			setPriorResult(result);
			setResult((await res.json()) as ProductFinderResult);
			setSupplementNote(supplement);
		} catch {
			setError(t("errors.failed"));
		}
	}

	function backToOriginal() {
		if (!priorResult) return;
		setResult(priorResult);
		setPriorResult(null);
		setSupplementNote(null);
	}

	return (
		<div className="space-y-4">
			<p className="rounded-md border border-dashed bg-muted/40 p-3 text-sm text-muted-foreground">
				{t("storedOnlyNotice")}
			</p>

			<ProductFinderForm onSubmit={run} pending={pending} />

			{error ? (
				<p className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
					{error}
				</p>
			) : null}

			{result ? (
				<section className="space-y-3">
					<header className="flex items-baseline justify-between">
						<h2 className="font-medium">{t("result.heading")}</h2>
						<p className="text-xs text-muted-foreground">
							{t("result.candidates", { count: result.candidateCount })}
						</p>
					</header>
					{supplementNote ? (
						<div className="flex flex-wrap items-center gap-2 rounded border border-amber-500/50 bg-amber-50/50 p-2 text-xs dark:bg-amber-950/20">
							<span>
								{t("supplement.applied", {
									count: supplementNote.evidenceCount,
									status: t(`supplement.status.${supplementNote.status}`),
								})}
							</span>
							{priorResult ? (
								<button type="button" onClick={backToOriginal} className="rounded border px-2 py-0.5">
									{t("supplement.backToOriginal")}
								</button>
							) : null}
						</div>
					) : null}

					{result.items.length === 0 ? (
						<p className="rounded border border-dashed p-4 text-sm text-muted-foreground">
							{t("result.empty")}
						</p>
					) : (
						<div className="space-y-3">
							{result.items.map((item) => (
								<ProductFinderResultCard
									key={item.id}
									item={item}
									runId={result.runId}
									onSupplemented={(supplement) => void showSupplemented(supplement)}
								/>
							))}
						</div>
					)}
				</section>
			) : null}
		</div>
	);
}
