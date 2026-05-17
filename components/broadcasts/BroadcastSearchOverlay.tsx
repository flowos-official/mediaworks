"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Search, X } from "lucide-react";
import HistoricalBroadcasts from "./HistoricalBroadcasts";

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

	// ESC to close.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open]);

	// Lock body scroll while open.
	useEffect(() => {
		if (!open) return;
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prev;
		};
	}, [open]);

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
				aria-label={t("historical.searchTitle")}
			>
				<Search size={14} />
				{t("historical.searchTitle")}
			</button>

			{open && (
				<div
					className="fixed inset-0 z-50 flex items-start justify-center pt-12 px-4"
					role="dialog"
					aria-modal="true"
				>
					<button
						type="button"
						aria-label="close"
						className="absolute inset-0 bg-black/40"
						onClick={() => setOpen(false)}
					/>
					<div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[calc(100vh-6rem)] overflow-y-auto">
						<div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-3 flex items-center justify-between rounded-t-2xl z-10">
							<h2 className="text-base font-semibold text-gray-900">
								{t("historical.searchTitle")}
							</h2>
							<button
								type="button"
								onClick={() => setOpen(false)}
								className="p-1.5 hover:bg-gray-100 rounded-lg"
								aria-label="close"
							>
								<X size={18} className="text-gray-500" />
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
