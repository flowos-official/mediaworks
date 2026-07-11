"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Loader2, PencilLine, Quote, Send, Sparkles, X } from "lucide-react";
import { useRefineSubmit } from "./use-refine-submit";

interface Props {
	screenplayId: string;
	versionId: string;
	selectedText: string | null;
	selectedLine: number | null;
	disabled?: boolean;
	onRefineStart: (runId: string) => void;
	onClearSelection: () => void;
	onDirectReplace: (replacement: string) => Promise<void>;
	directBusy?: boolean;
	directError?: string | null;
}

type Scope = "selection" | "document";

export function InlineAiEditor({
	screenplayId,
	versionId,
	selectedText,
	selectedLine,
	disabled = false,
	onRefineStart,
	onClearSelection,
	onDirectReplace,
	directBusy = false,
	directError = null,
}: Props) {
	const t = useTranslations("screenplay.workspace.aiEditor");
	const [prompt, setPrompt] = useState("");
	const [scope, setScope] = useState<Scope>(selectedText ? "selection" : "document");
	const [directMode, setDirectMode] = useState(false);
	const [replacement, setReplacement] = useState(selectedText ?? "");
	const promptRef = useRef<HTMLTextAreaElement>(null);
	const { submit, busy, err } = useRefineSubmit(screenplayId, versionId, (runId) => {
		setPrompt("");
		setDirectMode(false);
		onRefineStart(runId);
	});

	const quickActions = useMemo(
		() => [t("quickShorter"), t("quickNatural"), t("quickPersuasive"), t("quickCompliant")],
		[t],
	);

	function buildFeedback() {
		const instruction = prompt.trim();
		if (!instruction) return "";
		if (scope === "selection" && selectedText) {
			return [
				"【変更範囲】選択箇所のみ",
				selectedLine !== null ? `【開始行】${selectedLine + 1}` : "",
				`【対象原文】\n${selectedText}`,
				`【変更指示】\n${instruction}`,
				"【厳守】対象原文以外の構成・商品事実・価格・注記は変更しない。対象箇所だけを自然につながるように書き換える。",
			].filter(Boolean).join("\n\n");
		}
		return `【変更範囲】全文\n\n【変更指示】\n${instruction}\n\n【厳守】商品事実・価格・必須注記は根拠なく変更しない。`;
	}

	function requestRevision() {
		const feedback = buildFeedback();
		if (!feedback || disabled || busy) return;
		void submit(feedback);
	}

	function startDirectEdit() {
		if (!selectedText) return;
		setReplacement(selectedText);
		setDirectMode(true);
	}

	async function saveDirectEdit() {
		if (!selectedText || !replacement.trim() || replacement.trim() === selectedText.trim()) return;
		try {
			await onDirectReplace(replacement.trim());
			setDirectMode(false);
		} catch {
			// The parent exposes the actionable error in the dock.
		}
	}

	return (
		<section className="screenplay-ai-editor rounded-2xl border border-primary/20 bg-card/96 p-2.5 shadow-sm backdrop-blur-xl xl:sticky xl:top-0 xl:z-20" aria-label={t("title")}>
			<div className="mb-2 flex min-w-0 items-center justify-between gap-2 px-1">
				<div className="flex min-w-0 items-center gap-2">
					<span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Sparkles size={14} /></span>
					<div className="min-w-0">
						<div className="text-[11px] font-semibold text-foreground">{t("title")}</div>
						<div className="truncate text-[10px] text-muted-foreground">
							{selectedText ? `${t("selected")}: “${selectedText}”` : t("noSelection")}
						</div>
					</div>
				</div>
				{selectedText && (
					<button type="button" onClick={onClearSelection} className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t("clearSelection")} title={t("clearSelection")}>
						<X size={14} />
					</button>
				)}
			</div>

			{directMode && selectedText ? (
				<div className="space-y-2">
					<textarea
						value={replacement}
						onChange={(event) => setReplacement(event.target.value)}
						rows={4}
						disabled={directBusy}
						aria-label={t("directPlaceholder")}
						className="mw-scrollbar max-h-40 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
					/>
					<div className="flex items-center justify-between gap-2">
						{directError ? <p role="alert" className="text-[11px] text-red-600 dark:text-red-300">{directError}</p> : <span className="text-[10px] text-muted-foreground">{t("directHint")}</span>}
						<div className="ml-auto flex items-center gap-1.5">
							<button type="button" onClick={() => setDirectMode(false)} disabled={directBusy} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"><X size={12} />{t("cancelDirect")}</button>
							<button type="button" onClick={() => void saveDirectEdit()} disabled={directBusy || replacement.trim() === selectedText.trim()} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
								{directBusy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}{directBusy ? t("replacing") : t("replace")}
							</button>
						</div>
					</div>
				</div>
			) : (
				<>
					<div className="flex items-end gap-2 rounded-xl border border-border bg-background p-1.5 focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/12">
						<div className="min-w-0 flex-1">
							<div className="mb-1 flex items-center gap-1 px-1">
								<button type="button" onClick={() => selectedText && setScope("selection")} disabled={!selectedText} className={`rounded-md px-2 py-0.5 text-[10px] font-medium ${scope === "selection" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground disabled:opacity-40"}`}><Quote size={10} className="mr-1 inline" />{t("selectionScope")}</button>
								<button type="button" onClick={() => setScope("document")} className={`rounded-md px-2 py-0.5 text-[10px] font-medium ${scope === "document" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}>{t("documentScope")}</button>
							</div>
							<textarea
								id="inline-ai-prompt"
								ref={promptRef}
								value={prompt}
								onChange={(event) => setPrompt(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
										event.preventDefault();
										requestRevision();
									}
								}}
								rows={1}
								autoFocus={Boolean(selectedText)}
								disabled={disabled || busy}
								placeholder={selectedText ? t("selectionPlaceholder") : t("documentPlaceholder")}
								aria-label={selectedText ? t("selectionPlaceholder") : t("documentPlaceholder")}
								className="max-h-28 min-h-8 w-full resize-none bg-transparent px-1 text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
							/>
						</div>
						{selectedText && <button type="button" onClick={startDirectEdit} disabled={disabled || busy} className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40" aria-label={t("direct")} title={t("direct")}><PencilLine size={14} /></button>}
						<button type="button" onClick={requestRevision} disabled={disabled || busy || !prompt.trim()} className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40" aria-label={busy ? t("revising") : t("send")} title={`${t("send")} (⌘↵)`}>
							{busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
						</button>
					</div>
					<div className="mw-scrollbar mt-2 hidden gap-1.5 overflow-x-auto px-0.5 pb-0.5 sm:flex">
						{quickActions.map((action) => <button key={action} type="button" onClick={() => setPrompt(action)} className="min-h-7 shrink-0 rounded-full border border-border bg-background px-2.5 text-[10px] text-muted-foreground hover:border-primary/30 hover:text-foreground">{action}</button>)}
					</div>
					{err && <p role="alert" className="mt-1.5 px-1 text-[11px] text-red-600 dark:text-red-300">{err}</p>}
				</>
			)}
		</section>
	);
}
