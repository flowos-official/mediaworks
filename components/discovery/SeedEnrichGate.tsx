"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { Loader2, Sparkles, X, AlertTriangle } from "lucide-react";

interface Props {
	open: boolean;
	productId: string;
	onDone: () => void;
	onSkip: () => void;
	onClose: () => void;
}

export function SeedEnrichGateModal({
	open,
	productId,
	onDone,
	onSkip,
	onClose,
}: Props) {
	const t = useTranslations("discovery");
	const [mounted, setMounted] = useState(false);
	const [running, setRunning] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => setMounted(true), []);

	useEffect(() => {
		if (open) {
			setRunning(false);
			setFailed(false);
		}
	}, [open]);

	if (!open || !mounted) return null;

	async function enrichAndContinue() {
		setRunning(true);
		setFailed(false);
		try {
			await fetch(`/api/discovery/enrich/${productId}`, { method: "POST" });
			const start = Date.now();
			const poll = async (): Promise<"completed" | "failed" | "timeout"> => {
				while (Date.now() - start < 90_000) {
					await new Promise((r) => setTimeout(r, 2000));
					const res = await fetch(`/api/discovery/enrich/${productId}`);
					if (!res.ok) continue;
					const data = await res.json();
					if (data.status === "completed") return "completed";
					if (data.status === "failed") return "failed";
				}
				return "timeout";
			};
			const result = await poll();
			if (result === "completed") {
				onDone();
			} else {
				setFailed(true);
				setRunning(false);
			}
		} catch (err) {
			console.error("[seed-gate] enrich error", err);
			setFailed(true);
			setRunning(false);
		}
	}

	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
			onClick={() => !running && onClose()}
		>
			<div
				className="bg-white rounded-lg shadow-lg p-5 w-full max-w-md mx-4"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between mb-3">
					<h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
						<AlertTriangle size={14} className="text-amber-500" />
						{t("seedGateTitle")}
					</h3>
					{!running && (
						<button
							type="button"
							onClick={onClose}
							className="text-gray-400 hover:text-gray-600"
						>
							<X size={16} />
						</button>
					)}
				</div>

				<p className="text-xs text-gray-600 leading-relaxed mb-4">
					{failed ? t("seedGateFailed") : t("seedGateBody")}
				</p>

				{running ? (
					<div className="flex items-center justify-center gap-2 py-4 text-sm text-amber-700">
						<Loader2 size={16} className="animate-spin" />
						{t("seedGateRunning")}
					</div>
				) : failed ? (
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={onClose}
							className="px-4 py-1.5 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
						>
							{t("cancel")}
						</button>
						<button
							type="button"
							onClick={onSkip}
							className="px-4 py-1.5 text-xs bg-gray-500 text-white rounded hover:bg-gray-600"
						>
							{t("seedGateContinueAnyway")}
						</button>
					</div>
				) : (
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={onSkip}
							className="px-4 py-1.5 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
						>
							{t("seedGateSkip")}
						</button>
						<button
							type="button"
							onClick={enrichAndContinue}
							className="px-4 py-1.5 text-xs bg-amber-500 text-white rounded hover:bg-amber-600 inline-flex items-center gap-1"
						>
							<Sparkles size={12} />
							{t("seedGateEnrich")}
						</button>
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
