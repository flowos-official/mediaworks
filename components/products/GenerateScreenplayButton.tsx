"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2 } from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";

interface Props {
	productId: string;
	locale: string;
}

export function screenplayRunPath(
	locale: string,
	screenplayId: string,
	runId: string,
): string {
	return localePath(locale, `/screenplays/${screenplayId}?run=${runId}`);
}

export default function GenerateScreenplayButton({ productId, locale }: Props) {
	const router = useRouter();
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function createScreenplay() {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/screenplays", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ productId }),
			});
			const json = await res.json();
			if (!res.ok) throw new Error(json.error ?? "台本の作成に失敗しました");
			router.push(screenplayRunPath(locale, json.id, json.runId));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setLoading(false);
		}
	}

	return (
		<div className="flex flex-col items-end gap-1">
			<button
				type="button"
				onClick={createScreenplay}
				disabled={loading}
				className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background shadow-sm transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
			>
				{loading ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
				{loading ? "台本作成中..." : "台本を作成"}
			</button>
			{error && (
				<p className="max-w-64 text-right text-xs text-red-600 dark:text-red-400">
					{error}
				</p>
			)}
		</div>
	);
}
