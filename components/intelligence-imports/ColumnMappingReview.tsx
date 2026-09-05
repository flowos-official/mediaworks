"use client";

/**
 * Step 2 of 4. The operator's headers on the left, our fields on the right.
 *
 * The suggestion is shown as a preselection and never applied silently: a
 * wrong automatic mapping that looks right is worse than none, because it gets
 * confirmed and moved past. product_name is the only required field, and the
 * confirm button says so when it is missing rather than being inert.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";
import { IMPORT_FIELDS, METRIC_FIELDS, type ImportField } from "@/lib/intelligence/imports/types";
import type { UploadedBatch } from "./ImportUpload";

const OPTIONAL_METRIC = new Set<string>(METRIC_FIELDS);

export interface MappingResult {
	batchId: string;
	status: string;
	counts: { total: number; valid: number; invalid: number };
	rows: Array<{ rowNumber: number; productName: string; errors: string[] }>;
}

export function ColumnMappingReview({
	batch,
	onValidated,
}: {
	batch: UploadedBatch;
	onValidated: (result: MappingResult) => void;
}) {
	const t = useTranslations("imports.mapping");
	const [mapping, setMapping] = useState<Record<string, string>>(() =>
		Object.fromEntries(
			Object.entries(batch.suggestedMapping).filter((entry): entry is [string, string] =>
				Boolean(entry[1]),
			),
		),
	);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function confirm() {
		setPending(true);
		setError(null);
		try {
			const res = await fetch(`/api/intelligence/imports/${batch.batchId}/mapping`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mapping }),
			});
			const payload = (await res.json()) as MappingResult & { message?: string };
			if (!res.ok) {
				setError(payload.message ?? t("failed"));
				return;
			}
			onValidated(payload);
		} catch {
			setError(t("failed"));
		} finally {
			setPending(false);
		}
	}

	return (
		<section className="space-y-3 rounded-lg border p-4">
			<div>
				<h2 className="font-medium">{t("title")}</h2>
				<p className="text-sm text-muted-foreground">
					{t("sheet", { sheet: batch.sheetName, rows: batch.totalRows })}
				</p>
				{batch.duplicateOf.length > 0 ? (
					<p className="mt-1 rounded border border-amber-500/50 bg-amber-50/50 p-2 text-xs dark:bg-amber-950/20">
						{t("duplicateWarning", { count: batch.duplicateOf.length })}
					</p>
				) : null}
			</div>

			<div className="overflow-x-auto">
				<table className="w-full text-sm">
					<thead>
						<tr className="text-left text-xs text-muted-foreground">
							<th className="py-1 pr-3">{t("targetField")}</th>
							<th className="py-1">{t("sourceHeader")}</th>
						</tr>
					</thead>
					<tbody>
						{IMPORT_FIELDS.map((field: ImportField) => (
							<tr key={field} className="border-t">
								<td className="py-1 pr-3">
									{t(`field.${field}`)}
									{field === "product_name" ? (
										<span className="ml-1 text-red-600">*</span>
									) : OPTIONAL_METRIC.has(field) ? (
										<span className="ml-1 text-xs text-muted-foreground">{t("optional")}</span>
									) : null}
								</td>
								<td className="py-1">
									<select
										value={mapping[field] ?? ""}
										onChange={(event) =>
											setMapping((current) => {
												const next = { ...current };
												if (event.target.value) next[field] = event.target.value;
												else delete next[field];
												return next;
											})
										}
										className="h-8 w-full rounded border bg-background px-2 text-sm"
									>
										<option value="">{t("unmapped")}</option>
										{batch.headers.map((header) => (
											<option key={header} value={header}>
												{header}
											</option>
										))}
									</select>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<div className="overflow-x-auto rounded border">
				<table className="w-full text-xs">
					<thead className="bg-muted/40">
						<tr>
							<th className="p-1 text-left">#</th>
							{batch.headers.map((header) => (
								<th key={header} className="p-1 text-left">
									{header}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{batch.sampleRows.map((row) => (
							<tr key={row.rowNumber} className="border-t">
								<td className="p-1 tabular-nums text-muted-foreground">{row.rowNumber}</td>
								{batch.headers.map((header) => (
									<td key={header} className="p-1">
										{row.cells[header] === null || row.cells[header] === undefined
											? ""
											: String(row.cells[header])}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{error ? <p className="text-sm text-red-600">{error}</p> : null}
			<button
				type="button"
				disabled={pending || !mapping.product_name}
				onClick={() => void confirm()}
				className="rounded border px-3 py-1 text-sm disabled:opacity-50"
			>
				{pending ? t("validating") : t("confirm")}
			</button>
			{!mapping.product_name ? (
				<p className="text-xs text-red-600">{t("productNameRequired")}</p>
			) : null}
		</section>
	);
}
