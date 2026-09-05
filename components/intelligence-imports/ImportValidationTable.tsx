"use client";

/**
 * Step 3 of 4. What will be written, and what will not.
 *
 * Apply is disabled while zero rows are valid — a batch with nothing valid is
 * `failed` at the API too, so a live button here would only produce a 409 the
 * operator has to interpret. Invalid rows show their exact error and their
 * Excel row number, because the fix happens in Excel.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { MappingResult } from "./ColumnMappingReview";

export interface ApplyResult {
	appliedRows: number;
	failedRows: number;
	evidenceItems: number;
}

export function ImportValidationTable({
	batchId,
	validation,
	onApplied,
}: {
	batchId: string;
	validation: MappingResult;
	onApplied: (result: ApplyResult) => void;
}) {
	const t = useTranslations("imports.validation");
	const [pending, setPending] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const invalid = validation.rows.filter((row) => row.errors.length > 0);

	async function apply() {
		setPending(true);
		setError(null);
		try {
			const res = await fetch(`/api/intelligence/imports/${batchId}/apply`, { method: "POST" });
			const payload = (await res.json()) as ApplyResult & { message?: string };
			if (!res.ok) {
				setError(payload.message ?? t("failed"));
				return;
			}
			onApplied(payload);
		} catch {
			setError(t("failed"));
		} finally {
			setPending(false);
		}
	}

	return (
		<section className="space-y-3 rounded-lg border p-4">
			<h2 className="font-medium">{t("title")}</h2>
			<div className="flex flex-wrap gap-4 text-sm">
				<span>{t("valid", { count: validation.counts.valid })}</span>
				<span className={validation.counts.invalid > 0 ? "text-amber-700 dark:text-amber-300" : ""}>
					{t("invalid", { count: validation.counts.invalid })}
				</span>
				<span className="text-muted-foreground">{t("total", { count: validation.counts.total })}</span>
			</div>

			{invalid.length > 0 ? (
				<div className="overflow-x-auto rounded border">
					<table className="w-full text-xs">
						<thead className="bg-muted/40">
							<tr>
								<th className="p-1 text-left">{t("rowNumber")}</th>
								<th className="p-1 text-left">{t("productName")}</th>
								<th className="p-1 text-left">{t("errors")}</th>
							</tr>
						</thead>
						<tbody>
							{invalid.slice(0, 50).map((row) => (
								<tr key={row.rowNumber} className="border-t">
									<td className="p-1 tabular-nums">{row.rowNumber}</td>
									<td className="p-1">{row.productName}</td>
									<td className="p-1 text-red-600">{row.errors.join(" / ")}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}

			{error ? <p className="text-sm text-red-600">{error}</p> : null}

			{confirming ? (
				<div className="space-y-2 rounded border border-amber-500/50 bg-amber-50/50 p-2 dark:bg-amber-950/20">
					<p className="text-sm">{t("confirmSentence", { count: validation.counts.valid })}</p>
					<div className="flex gap-2">
						<button
							type="button"
							disabled={pending}
							onClick={() => void apply()}
							className="rounded bg-amber-600 px-3 py-1 text-sm text-white disabled:opacity-50"
						>
							{pending ? t("applying") : t("confirmApply")}
						</button>
						<button
							type="button"
							disabled={pending}
							onClick={() => setConfirming(false)}
							className="rounded border px-3 py-1 text-sm"
						>
							{t("cancel")}
						</button>
					</div>
				</div>
			) : (
				<button
					type="button"
					disabled={validation.counts.valid === 0}
					onClick={() => setConfirming(true)}
					className="rounded border px-3 py-1 text-sm disabled:opacity-50"
				>
					{t("apply")}
				</button>
			)}
			{validation.counts.valid === 0 ? (
				<p className="text-xs text-muted-foreground">{t("nothingToApply")}</p>
			) : null}
		</section>
	);
}
