"use client";

/**
 * Step 1 of 4. One spreadsheet, and nothing has happened to the ledger yet.
 *
 * The copy is explicit that performance columns are optional, because the
 * common case is a product master with no cost data and an operator who
 * assumes the import is not for them.
 */
import { useRef, useState } from "react";
import { useTranslations } from "next-intl";

export interface UploadedBatch {
	batchId: string;
	sheetName: string;
	headers: string[];
	suggestedMapping: Record<string, string | undefined>;
	sampleRows: Array<{ rowNumber: number; cells: Record<string, unknown> }>;
	totalRows: number;
	truncated: boolean;
	duplicateOf: string[];
}

export function ImportUpload({ onUploaded }: { onUploaded: (batch: UploadedBatch) => void }) {
	const t = useTranslations("imports.upload");
	const inputRef = useRef<HTMLInputElement>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(file: File) {
		setPending(true);
		setError(null);
		try {
			const body = new FormData();
			body.append("file", file);
			const res = await fetch("/api/intelligence/imports", { method: "POST", body });
			const payload = (await res.json()) as UploadedBatch & { message?: string };
			if (!res.ok || !payload.batchId) {
				setError(payload.message ?? t("failed"));
				return;
			}
			onUploaded(payload);
		} catch {
			setError(t("failed"));
		} finally {
			setPending(false);
			if (inputRef.current) inputRef.current.value = "";
		}
	}

	return (
		<section className="space-y-2 rounded-lg border p-4">
			<h2 className="font-medium">{t("title")}</h2>
			<p className="text-sm text-muted-foreground">{t("description")}</p>
			{/* The reason most operators think this feature is not for them. */}
			<p className="text-xs text-muted-foreground">{t("optionalColumns")}</p>
			<input
				ref={inputRef}
				type="file"
				accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
				disabled={pending}
				onChange={(event) => {
					const file = event.target.files?.[0];
					if (file) void submit(file);
				}}
				className="block w-full text-sm"
			/>
			{pending ? <p className="text-sm text-muted-foreground">{t("uploading")}</p> : null}
			{error ? <p className="text-sm text-red-600">{error}</p> : null}
		</section>
	);
}
