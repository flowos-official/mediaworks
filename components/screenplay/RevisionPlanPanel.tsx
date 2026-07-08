"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Send, Sparkles, Wand2, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { composeRefineFeedback, type RevisionPlanItem } from "@/lib/screenplay/revision-plan";
import { useRefineSubmit } from "./use-refine-submit";

interface Props {
	screenplayId: string;
	versionId: string;
	markdown: string;
	disabled?: boolean;
	onRefineStart: (runId: string) => void;
}

const AXIS_KEY: Record<RevisionPlanItem["axis"], string> = {
	legal: "review.axisLegal",
	facts: "review.axisFacts",
	quality: "review.axisQuality",
};
const SEV_KEY: Record<RevisionPlanItem["severity"], string> = {
	high: "review.sevHigh",
	med: "review.sevMed",
	low: "review.sevLow",
};
const SEV_CLS: Record<RevisionPlanItem["severity"], string> = {
	high: "bg-red-600/15 text-red-700 dark:text-red-300",
	med: "bg-yellow-600/15 text-yellow-700 dark:text-yellow-300",
	low: "bg-blue-600/15 text-blue-700 dark:text-blue-300",
};

export function RevisionPlanPanel({ screenplayId, versionId, markdown, disabled, onRefineStart }: Props) {
	const t = useTranslations("screenplay");
	const suggestions = t.raw("feedback.suggestions") as string[];
	const { submit, busy, err, setErr } = useRefineSubmit(screenplayId, versionId, onRefineStart);

	const [items, setItems] = useState<RevisionPlanItem[] | null>(null);
	const [selected, setSelected] = useState<boolean[]>([]);
	const [findingCount, setFindingCount] = useState<number | null>(null);
	const [basedOnScore, setBasedOnScore] = useState<number | null>(null);
	const [planLoading, setPlanLoading] = useState(false);
	const [planErr, setPlanErr] = useState<string | null>(null);
	const [freeText, setFreeText] = useState("");
	const [trimmed, setTrimmed] = useState(0);

	// Stale-drop: clear plan state on version switch; drop in-flight responses
	// so a plan generated for 第N稿 can't be composed against a switched-to base.
	const versionRef = useRef(versionId);
	useEffect(() => {
		versionRef.current = versionId;
		setItems(null); setSelected([]); setFindingCount(null); setBasedOnScore(null);
		setPlanErr(null); setFreeText(""); setTrimmed(0); setErr(null);
	}, [versionId, setErr]);

	async function propose() {
		const reqVersion = versionId;
		setPlanLoading(true);
		setPlanErr(null);
		setTrimmed(0);
		try {
			const res = await fetch(`/api/screenplays/${screenplayId}/versions/${versionId}/revision-plan`, { method: "POST" });
			const j = (await res.json()) as { plan?: { items: RevisionPlanItem[] }; basedOnScore?: number; findingCount?: number; error?: string };
			if (!res.ok) throw new Error(j.error ?? t("review.plan.failed"));
			if (reqVersion !== versionRef.current) return;
			const its = j.plan?.items ?? [];
			setItems(its);
			setSelected(its.map(() => true));
			setFindingCount(j.findingCount ?? 0);
			setBasedOnScore(j.basedOnScore ?? null);
		} catch (e) {
			if (reqVersion === versionRef.current) setPlanErr(e instanceof Error ? e.message : String(e));
		} finally {
			if (reqVersion === versionRef.current) setPlanLoading(false);
		}
	}

	function toggle(i: number) {
		setSelected((s) => s.map((v, idx) => (idx === i ? !v : v)));
	}

	function onApply() {
		const chosen = (items ?? []).filter((_, i) => selected[i]);
		const { feedback, trimmedCount } = composeRefineFeedback(chosen, freeText, markdown);
		setTrimmed(trimmedCount);
		if (!feedback.trim()) return;
		void submit(feedback);
	}

	const hasSelection = selected.some(Boolean);
	const canApply = !disabled && !busy && (hasSelection || freeText.trim().length > 0);

	return (
		<Card className="border-border">
			<CardContent className="p-5 space-y-4">
				{/* Plan generation */}
				<div>
					<div className="flex items-center justify-between mb-2">
						<div className="flex items-center gap-2">
							<div className="w-8 h-8 bg-blue-600/10 rounded-lg flex items-center justify-center">
								<ShieldCheck size={16} className="text-blue-600" />
							</div>
							<div>
								<h3 className="text-sm font-semibold text-foreground">{t("review.plan.heading")}</h3>
								{basedOnScore != null && findingCount != null && (
									<p className="text-[11px] text-muted-foreground">{t("review.plan.basedOnScore", { score: basedOnScore, count: findingCount })}</p>
								)}
							</div>
						</div>
						<button
							type="button"
							onClick={propose}
							disabled={disabled || planLoading}
							className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 border border-border rounded-lg hover:border-blue-200 hover:bg-blue-600/10 text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{planLoading ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
							{planLoading ? t("review.plan.generating") : items ? t("review.plan.regenerate") : t("review.plan.proposeBtn")}
						</button>
					</div>

					{planErr && (
						<div className="mb-2 p-2.5 bg-red-600/10 border border-red-200 dark:border-red-900/40 rounded-lg text-xs text-red-700 dark:text-red-300">{planErr}</div>
					)}

					{items && items.length === 0 && (
						<p className="text-xs text-muted-foreground py-2">{t("review.plan.emptyNoFindings")}</p>
					)}

					{items && items.length > 0 && (
						<div className="space-y-2">
							{items.map((it, i) => (
								<label key={i} className="flex items-start gap-2 rounded-lg border border-border p-2.5 text-xs cursor-pointer hover:bg-muted/50">
									<input type="checkbox" checked={selected[i] ?? false} onChange={() => toggle(i)} className="mt-0.5" />
									<span className="flex-1 min-w-0 space-y-1">
										<span className="flex items-center gap-1.5">
											<span className="inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{t(AXIS_KEY[it.axis])}</span>
											<span className={`inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${SEV_CLS[it.severity]}`}>{t(SEV_KEY[it.severity])}</span>
										</span>
										{it.target && <span className="block text-muted-foreground break-all">「{it.target}」</span>}
										<span className="block text-foreground">{it.instruction}</span>
									</span>
								</label>
							))}
						</div>
					)}
				</div>

				{/* Manual feedback */}
				<div className="border-t border-border pt-4">
					<div className="flex items-center gap-2 mb-2">
						<Sparkles size={14} className="text-blue-600" />
						<h4 className="text-sm font-semibold text-foreground">{t("review.plan.manualHeading")}</h4>
					</div>
					<textarea
						value={freeText}
						onChange={(e) => setFreeText(e.target.value)}
						rows={4}
						disabled={disabled || busy}
						placeholder={t("feedback.placeholder")}
						className="w-full px-3 py-2.5 text-sm border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none"
					/>
					<div className="mt-2">
						<div className="text-[11px] font-medium text-muted-foreground mb-1.5">{t("feedback.frequentRequests")}</div>
						<div className="space-y-1.5">
							{suggestions.map((s) => (
								<button
									key={s}
									type="button"
									onClick={() => setFreeText((v) => (v ? v + "\n" : "") + s)}
									className="w-full text-left text-xs px-3 py-2 border border-border rounded-lg hover:border-blue-200 hover:bg-blue-600/10 text-foreground transition-colors"
								>
									<span className="text-blue-500 mr-1.5">＋</span>{s}
								</button>
							))}
						</div>
					</div>
				</div>

				{trimmed > 0 && (
					<p className="text-[11px] text-yellow-700 dark:text-yellow-300">{t("review.plan.itemsTrimmed", { count: trimmed })}</p>
				)}
				{err && (
					<div className="p-2.5 bg-red-600/10 border border-red-200 dark:border-red-900/40 rounded-lg text-xs text-red-700 dark:text-red-300">{err}</div>
				)}

				<button
					type="button"
					onClick={onApply}
					disabled={!canApply}
					className="w-full inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				>
					{busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
					{busy ? t("feedback.sending") : t("review.plan.applyBtn")}
				</button>
			</CardContent>
		</Card>
	);
}
