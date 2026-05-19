"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Clapperboard } from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";

interface Props {
	productId: string;
	locale: string;
}

export default function GenerateScreenplayButton({ productId, locale }: Props) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleClick() {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/screenplays", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ productId }),
			});
			const json = await res.json();
			if (!res.ok || !json.id) {
				setError(json.error ?? "台本生成に失敗しました");
				return;
			}
			router.push(localePath(locale, `/screenplays/${json.id}`));
		} catch (err) {
			setError(err instanceof Error ? err.message : "unexpected error");
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<button
				type="button"
				onClick={handleClick}
				disabled={busy}
				className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition-colors"
			>
				<Clapperboard size={14} />
				{busy ? "台本作成中…" : "この商品で台本を生成"}
			</button>
			{error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
		</>
	);
}
