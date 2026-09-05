"use client";

/**
 * The four stages, in order: upload → mapping → validation → apply.
 *
 * The order is enforced by what exists, not by a wizard: mapping cannot render
 * without an uploaded batch, validation cannot render without a confirmed
 * mapping, and apply lives inside validation where the counts are.
 */
import { useCallback, useState } from "react";
import { useTranslations } from "next-intl";
import { ImportUpload, type UploadedBatch } from "./ImportUpload";
import { ColumnMappingReview, type MappingResult } from "./ColumnMappingReview";
import { ImportValidationTable, type ApplyResult } from "./ImportValidationTable";
import { ImportBatchHistory, type ImportBatchRow } from "./ImportBatchHistory";

export function DataManagementClient({
	initialBatches,
}: {
	/** Loaded on the server. The history is not a client concern on first paint,
	 *  and fetching it from an effect meant a second round trip plus a cascading
	 *  render for something the page already had. */
	initialBatches: ImportBatchRow[];
}) {
	const t = useTranslations("imports");
	const [batch, setBatch] = useState<UploadedBatch | null>(null);
	const [validation, setValidation] = useState<MappingResult | null>(null);
	const [applied, setApplied] = useState<ApplyResult | null>(null);
	const [batches, setBatches] = useState<ImportBatchRow[]>(initialBatches);

	// Called after a mutation only — never on mount.
	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/intelligence/imports");
			if (!res.ok) return;
			const payload = (await res.json()) as { batches?: ImportBatchRow[] };
			setBatches(payload.batches ?? []);
		} catch {
			// History is supplementary; a failed refresh must not break the flow.
		}
	}, []);

	return (
		<div className="space-y-4">
			<ImportUpload
				onUploaded={(uploaded) => {
					setBatch(uploaded);
					setValidation(null);
					setApplied(null);
				}}
			/>

			{batch ? (
				<ColumnMappingReview
					batch={batch}
					onValidated={(result) => {
						setValidation(result);
						setApplied(null);
						void refresh();
					}}
				/>
			) : null}

			{batch && validation ? (
				<ImportValidationTable
					batchId={batch.batchId}
					validation={validation}
					onApplied={(result) => {
						setApplied(result);
						void refresh();
					}}
				/>
			) : null}

			{applied ? (
				<p className="rounded border border-emerald-500/50 bg-emerald-50/50 p-3 text-sm dark:bg-emerald-950/20">
					{t("applied", {
						rows: applied.appliedRows,
						failed: applied.failedRows,
						evidence: applied.evidenceItems,
					})}
				</p>
			) : null}

			<ImportBatchHistory batches={batches} onChanged={() => void refresh()} />
		</div>
	);
}
