"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";

// Single source of truth for the POST /refine call (shared so the composed
// plan submit and any manual submit use the exact same request).
export function useRefineSubmit(
	screenplayId: string,
	baseVersionId: string,
	onStart: (runId: string) => void,
) {
	const tErr = useTranslations("screenplay.errors");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function submit(feedback: string) {
		const fb = feedback.trim();
		if (!fb) return;
		setBusy(true);
		setErr(null);
		try {
			const res = await fetch(`/api/screenplays/${screenplayId}/refine`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: fb, baseVersionId }),
			});
			const j = await res.json();
			if (!res.ok) throw new Error(j.error ?? tErr("refineFailed"));
			onStart(j.runId as string);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return { submit, busy, err, setErr };
}
