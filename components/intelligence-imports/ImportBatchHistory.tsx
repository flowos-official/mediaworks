"use client";

/**
 * Every batch, and how to undo one.
 *
 * Rollback requires a typed reason. "Why did this number change?" arrives
 * weeks after the fact, and a rollback with no reason cannot answer it — so
 * the button is inert until the reason is long enough, and the API enforces
 * the same bound rather than trusting the form.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";

export interface ImportBatchRow {
	id: string;
	file_name: string;
	file_sha256: string;
	status: string;
	row_counts: Record<string, number> | null;
	created_at: string;
	updated_at: string;
}

const ROLLBACKABLE = new Set(["applied", "partial"]);
const MIN_REASON = 3;

export function ImportBatchHistory({
	batches,
	onChanged,
}: {
	batches: ImportBatchRow[];
	onChanged: () => void;
}) {
	const t = useTranslations("imports.history");
	const [openFor, setOpenFor] = useState<string | null>(null);
	const [reason, setReason] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function rollback(batchId: string) {
		setPending(true);
		setError(null);
		try {
			const res = await fetch(`/api/intelligence/imports/${batchId}/rollback`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason }),
			});
			const payload = (await res.json()) as { message?: string };
			if (!res.ok) {
				setError(payload.message ?? t("failed"));
				return;
			}
			setOpenFor(null);
			setReason("");
			onChanged();
		} catch {
			setError(t("failed"));
		} finally {
			setPending(false);
		}
	}

	if (batches.length === 0) {
		return <p className="rounded border border-dashed p-4 text-sm text-muted-foreground">{t("empty")}</p>;
	}

	return (
		<section className="space-y-2">
			<h2 className="font-medium">{t("title")}</h2>
			<div className="overflow-x-auto rounded border">
				<table className="w-full text-sm">
					<thead className="bg-muted/40 text-xs">
						<tr>
							<th className="p-2 text-left">{t("file")}</th>
							{/* `status` is the status -> label map, so it cannot double as the
								    column header: next-intl returns the key path when a
								    message resolves to an object, and the header rendered
								    as "imports.history.status" on screen. */}
								<th className="p-2 text-left">{t("statusLabel")}</th>
							<th className="p-2 text-left">{t("rows")}</th>
							<th className="p-2 text-left">{t("hash")}</th>
							<th className="p-2 text-left">{t("updated")}</th>
							<th className="p-2" />
						</tr>
					</thead>
					<tbody>
						{batches.map((batch) => (
							<tr key={batch.id} className="border-t align-top">
								<td className="p-2">{batch.file_name}</td>
								<td className="p-2">{t(`status.${batch.status}`)}</td>
								<td className="p-2 tabular-nums text-xs text-muted-foreground">
									{Object.entries(batch.row_counts ?? {})
										.map(([key, value]) => `${key}:${value}`)
										.join(" ")}
								</td>
								<td className="p-2 font-mono text-xs text-muted-foreground">
									{batch.file_sha256.slice(0, 12)}
								</td>
								<td className="p-2 text-xs text-muted-foreground">{batch.updated_at.slice(0, 10)}</td>
								<td className="p-2">
									{ROLLBACKABLE.has(batch.status) ? (
										openFor === batch.id ? (
											<div className="space-y-1">
												<input
													value={reason}
													onChange={(event) => setReason(event.target.value)}
													placeholder={t("reasonPlaceholder")}
													className="h-8 w-56 rounded border bg-background px-2 text-xs"
												/>
												<div className="flex gap-1">
													<button
														type="button"
														disabled={pending || reason.trim().length < MIN_REASON}
														onClick={() => void rollback(batch.id)}
														className="rounded border px-2 py-0.5 text-xs disabled:opacity-50"
													>
														{t("confirmRollback")}
													</button>
													<button
														type="button"
														disabled={pending}
														onClick={() => setOpenFor(null)}
														className="rounded border px-2 py-0.5 text-xs"
													>
														{t("cancel")}
													</button>
												</div>
											</div>
										) : (
											<button
												type="button"
												onClick={() => {
													setOpenFor(batch.id);
													setReason("");
												}}
												className="rounded border px-2 py-0.5 text-xs"
											>
												{t("rollback")}
											</button>
										)
									) : null}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{error ? <p className="text-sm text-red-600">{error}</p> : null}
			<p className="text-xs text-muted-foreground">{t("rollbackNote")}</p>
		</section>
	);
}
