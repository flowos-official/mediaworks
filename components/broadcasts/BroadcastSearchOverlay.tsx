"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Search, X } from "lucide-react";
import HistoricalBroadcasts from "./HistoricalBroadcasts";
import { useDialogBehavior } from "@/components/ui/use-dialog-behavior";

interface Props {
	channelCounts: Record<string, number>;
}

/**
 * Trigger button (top of page) + modal overlay that wraps the existing
 * cross-channel search UI. Keeps the calendar as the primary surface and
 * surfaces search on demand, without claiming permanent screen real estate.
 */
export default function BroadcastSearchOverlay({ channelCounts }: Props) {
	const t = useTranslations("broadcasts");
	const [open, setOpen] = useState(false);
	const dialogRef = useRef<HTMLDivElement>(null);
	useDialogBehavior(open, () => setOpen(false), dialogRef);

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted"
				aria-label={t("historical.searchTitle")}
			>
				<Search size={14} />
				{t("historical.searchTitle")}
			</button>

			{open && (
				<div
					ref={dialogRef}
					className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4"
					role="dialog"
					aria-modal="true"
					aria-labelledby="broadcast-search-title"
					tabIndex={-1}
				>
					<button
						type="button"
						aria-label="close"
						className="absolute inset-0 bg-black/40"
						onClick={() => setOpen(false)}
					/>
					<div className="relative bg-card rounded-2xl shadow-2xl w-full max-w-5xl max-h-[calc(100vh-6rem)] overflow-y-auto">
						<div className="sticky top-0 bg-card border-b border-border px-6 py-3 flex items-center justify-between rounded-t-2xl z-10">
							<h2 id="broadcast-search-title" className="text-base font-semibold text-foreground">
								{t("historical.searchTitle")}
							</h2>
							<button
								data-dialog-autofocus
								type="button"
								onClick={() => setOpen(false)}
								className="p-1.5 hover:bg-muted rounded-lg"
								aria-label="close"
							>
								<X size={18} className="text-muted-foreground" />
							</button>
						</div>
						<div className="px-6 pb-6">
							{/* HistoricalBroadcasts already has its own internal padding (`mt-12 pt-8 border-t`).
							    Override that visual treatment by rendering inside this container — the
							    component's outer <section className="mt-12 ..."> still applies but the
							    container's own padding makes it look natural inside the modal. */}
							<HistoricalBroadcasts channelCounts={channelCounts} />
						</div>
					</div>
				</div>
			)}
		</>
	);
}
