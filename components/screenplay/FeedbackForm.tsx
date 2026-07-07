"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Send, Loader2, Sparkles } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface Props {
	screenplayId: string;
	baseVersionId: string;
	disabled?: boolean;
	onStart: (runId: string) => void;
}

export function FeedbackForm({ screenplayId, baseVersionId, disabled, onStart }: Props) {
	const t = useTranslations("screenplay.feedback");
	const tErr = useTranslations("screenplay.errors");
	const suggestions = t.raw("suggestions") as string[];
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	async function submit() {
		const feedback = text.trim();
		if (!feedback) return;
		setBusy(true);
		setErr(null);
		try {
			const res = await fetch(`/api/screenplays/${screenplayId}/refine`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback, baseVersionId }),
			});
			const j = await res.json();
			if (!res.ok) throw new Error(j.error ?? tErr("refineFailed"));
			onStart(j.runId as string);
			setText("");
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Card className="border-border">
			<CardContent className="p-5">
				<div className="flex items-center gap-2 mb-3">
					<div className="w-8 h-8 bg-blue-600/10 rounded-lg flex items-center justify-center">
						<Sparkles size={16} className="text-blue-600" />
					</div>
					<div>
						<h3 className="text-sm font-semibold text-foreground">{t("heading")}</h3>
						<p className="text-[11px] text-muted-foreground">{t("hint")}</p>
					</div>
				</div>

				<textarea
					value={text}
					onChange={(e) => setText(e.target.value)}
					rows={5}
					disabled={disabled || busy}
					placeholder={t("placeholder")}
					className="w-full px-3 py-2.5 text-sm border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none"
				/>

				<div className="mt-3">
					<div className="text-[11px] font-medium text-muted-foreground mb-1.5">{t("frequentRequests")}</div>
					<div className="space-y-1.5">
						{suggestions.map((s) => (
							<button
								key={s}
								type="button"
								onClick={() => setText((t) => (t ? t + "\n" : "") + s)}
								className="w-full text-left text-xs px-3 py-2 border border-border rounded-lg hover:border-blue-200 hover:bg-blue-600/10 text-foreground transition-colors"
							>
								<span className="text-blue-500 mr-1.5">＋</span>
								{s}
							</button>
						))}
					</div>
				</div>

				{err && (
					<div className="mt-3 p-2.5 bg-red-600/10 border border-red-200 dark:border-red-900/40 rounded-lg text-xs text-red-700 dark:text-red-300">
						{err}
					</div>
				)}

				<button
					type="button"
					onClick={submit}
					disabled={disabled || busy || !text.trim()}
					className="mt-4 w-full inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
					{busy ? t("sending") : t("submit")}
				</button>
			</CardContent>
		</Card>
	);
}
