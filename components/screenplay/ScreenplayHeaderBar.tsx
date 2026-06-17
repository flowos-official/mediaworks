"use client";
import { useState } from "react";
import { Copy, Download, Check, ChevronLeft, ChevronRight, FileText } from "lucide-react";

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
function formatStamp(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return `${d.getFullYear()}/${pad(d.getMonth() + 1, 2)}/${pad(d.getDate(), 2)} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
}

export function ScreenplayHeaderBar({ markdown, title, versionLabel, createdAt, hasPrev, hasNext, onPrev, onNext, prevLabel, nextLabel }: Props) {
	const [copied, setCopied] = useState(false);
	const [docxBusy, setDocxBusy] = useState(false);
	const chars = markdown.length;
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
					title={prevLabel ? `前のバージョン (第 ${prevLabel.replace("v", "")} 稿)` : "前のバージョン"}
					className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-foreground hover:bg-muted rounded-md disabled:text-muted-foreground disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors">
					<ChevronLeft size={14} /> 前へ
				</button>
				<button type="button" onClick={onNext} disabled={!hasNext}
					title={nextLabel ? `次のバージョン (第 ${nextLabel.replace("v", "")} 稿)` : "次のバージョン"}
					className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-foreground hover:bg-muted rounded-md disabled:text-muted-foreground disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors">
					次へ <ChevronRight size={14} />
				</button>
			</div>
			<div className="flex items-baseline gap-3 text-xs text-muted-foreground min-w-0">
				{versionLabel && <span className="font-semibold text-foreground whitespace-nowrap">{versionLabel}</span>}
				{createdAt && <span className="tabular-nums whitespace-nowrap">{formatStamp(createdAt)}</span>}
				<span className="tabular-nums whitespace-nowrap hidden sm:inline">{chars.toLocaleString()} 文字</span>
			</div>
			<div className="flex items-center gap-1">
				<button type="button" onClick={copyMd} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:bg-muted rounded-md transition-colors">
					{copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "コピー済み" : "コピー"}
				</button>
				<button type="button" onClick={downloadMd} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:bg-muted rounded-md transition-colors">
					<Download size={12} /> .md
				</button>
				<button type="button" onClick={downloadDocx} disabled={docxBusy} className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:bg-muted rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
					<FileText size={12} /> {docxBusy ? "生成中…" : "Word"}
				</button>
			</div>
		</div>
	);
}
