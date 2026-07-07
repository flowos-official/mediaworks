"use client";
import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Copy, Download, Check, ChevronLeft, ChevronRight, FileText } from "lucide-react";
import { parseMarkdown } from "@/lib/screenplay/parse-markdown";

interface Props {
	markdown: string;
	title: string;
	versionLabel?: string;
	createdAt?: string;
	hasPrev?: boolean;
	hasNext?: boolean;
	onPrev?: () => void;
	onNext?: () => void;
	prevLabel?: string;
	nextLabel?: string;
}

function pad(n: number, w: number): string { return n.toString().padStart(w, "0"); }

// Count the rendered SCRIPT text (dialogue, narration, cues, tables…) rather than
// raw markdown length — markdown syntax (##, **, |, -) and whitespace shouldn't
// inflate the "文字数" an operator reads as broadcast content length.
function renderedTextLength(md: string): number {
	const strip = (s: string) => s.replace(/\s/g, "").length;
	let n = 0;
	for (const b of parseMarkdown(md)) {
		if (b.kind === "heading") n += strip(b.text);
		else if (b.kind === "para") n += strip(b.text);
		else if (b.kind === "cue") n += strip(b.lines.join(""));
		else if (b.kind === "speaker") n += strip((b.delivery ?? "") + b.jp + (b.en ?? ""));
		else if (b.kind === "list") n += strip(b.items.join(""));
		else if (b.kind === "table") n += strip(b.rows.flat().join(""));
	}
	return n;
}
function formatStamp(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return `${d.getFullYear()}/${pad(d.getMonth() + 1, 2)}/${pad(d.getDate(), 2)} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
}

export function ScreenplayHeaderBar({ markdown, title, versionLabel, createdAt, hasPrev, hasNext, onPrev, onNext, prevLabel, nextLabel }: Props) {
	const t = useTranslations("screenplay.workspace");
	const [copied, setCopied] = useState(false);
	const [docxBusy, setDocxBusy] = useState(false);
	const chars = useMemo(() => renderedTextLength(markdown), [markdown]);
	const safeName = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}${versionLabel ? `-${versionLabel.replace(/\s+/g, "")}` : ""}`;

	function downloadMd() {
		const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a"); a.href = url; a.download = `${safeName}.md`; a.click();
		URL.revokeObjectURL(url);
	}
	async function downloadDocx() {
		setDocxBusy(true);
		try {
			const { buildScreenplayDocx } = await import("@/lib/screenplay/screenplay-docx");
			const blob = await buildScreenplayDocx(markdown, title);
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a"); a.href = url; a.download = `${safeName}.docx`; a.click();
			URL.revokeObjectURL(url);
		} finally { setDocxBusy(false); }
	}
	async function copyMd() {
		await navigator.clipboard.writeText(markdown);
		setCopied(true); setTimeout(() => setCopied(false), 1500);
	}

	return (
		<div className="sticky top-16 z-20 flex items-center justify-between gap-3 bg-card/95 backdrop-blur-sm border border-border rounded-xl px-3 py-2 mb-4 flex-wrap">
			<div className="flex items-center gap-1">
				<button type="button" onClick={onPrev} disabled={!hasPrev}
					title={prevLabel ? t("prevVersionWithDraft", { n: prevLabel.replace("v", "") }) : t("prevVersion")}
					className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-foreground hover:bg-muted rounded-md disabled:text-muted-foreground disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors">
					<ChevronLeft size={14} /> {t("prev")}
				</button>
				<button type="button" onClick={onNext} disabled={!hasNext}
					title={nextLabel ? t("nextVersionWithDraft", { n: nextLabel.replace("v", "") }) : t("nextVersion")}
					className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-foreground hover:bg-muted rounded-md disabled:text-muted-foreground disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors">
					{t("next")} <ChevronRight size={14} />
				</button>
			</div>
			<div className="flex items-baseline gap-3 text-xs text-muted-foreground min-w-0">
				{versionLabel && <span className="font-semibold text-foreground whitespace-nowrap">{versionLabel}</span>}
				{createdAt && <span className="tabular-nums whitespace-nowrap">{formatStamp(createdAt)}</span>}
				<span className="tabular-nums whitespace-nowrap hidden sm:inline">{t("chars", { n: chars.toLocaleString() })}</span>
			</div>
			<div className="flex items-center gap-1">
				<button type="button" onClick={copyMd} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:bg-muted rounded-md transition-colors">
					{copied ? <Check size={12} /> : <Copy size={12} />} {copied ? t("copied") : t("copy")}
				</button>
				<button type="button" onClick={downloadMd} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:bg-muted rounded-md transition-colors">
					<Download size={12} /> .md
				</button>
				<button type="button" onClick={downloadDocx} disabled={docxBusy} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:bg-muted rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
					<FileText size={12} /> {docxBusy ? t("generating") : "Word"}
				</button>
			</div>
		</div>
	);
}
