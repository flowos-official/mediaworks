"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Sparkles } from "lucide-react";
import type { Context } from "@/lib/discovery/types";

export function ManualTriggerButton({ context, onStarted }: { context: Context; onStarted?: () => void }) {
	const t = useTranslations("discovery");
	const [loading, setLoading] = useState(false);
	const [status, setStatus] = useState<"idle" | "running" | "done" | "failed">("idle");

	async function trigger() {
		setLoading(true);
		setStatus("running");
		onStarted?.();
		try {
			const res = await fetch("/api/discovery/manual-trigger", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ context }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setStatus("done");
		} catch {
			setStatus("failed");
		} finally {
			setLoading(false);
		}
	}

	return (
		<button
			type="button"
			onClick={trigger}
			disabled={loading}
			className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border transition-colors disabled:opacity-60 disabled:cursor-not-allowed bg-amber-500 text-white border-amber-500 hover:bg-amber-600"
		>
			{loading ? (
				<>
					<Loader2 size={12} className="animate-spin" />
					{t("manualTriggerRunning")}
				</>
			) : status === "done" ? (
				<>
					<Sparkles size={12} />
					{t("manualTriggerSuccess")}
				</>
			) : status === "failed" ? (
				<>{t("manualTriggerFailed")}</>
			) : (
				<>
					<Sparkles size={12} />
					{t("manualTrigger")}
				</>
			)}
		</button>
	);
}
