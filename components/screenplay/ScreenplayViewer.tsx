"use client";
import { useState } from "react";
import { Copy, Download, Check, ChevronLeft, ChevronRight, FileText, GitCompare } from "lucide-react";
import { ChangeDiffView } from "./ChangeDiffView";
import { Card } from "@/components/ui/card";
import { ScreenplayMarkdown } from "./markdown-renderer";

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
	baseMarkdown?: string;
	screenplayId?: string;
	versionId?: string;
}

function pad(n: number, w: number): string {
	return n.toString().padStart(w, "0");
}

function formatStamp(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	return `${d.getFullYear()}/${pad(d.getMonth() + 1, 2)}/${pad(d.getDate(), 2)} ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
}

export function ScreenplayViewer({
	markdown,
	title,
	versionLabel,
	createdAt,
	hasPrev,
	hasNext,
	onPrev,
	onNext,
	prevLabel,
	nextLabel,
	baseMarkdown,
	screenplayId,
	versionId,
}: Props) {
	const [copied, setCopied] = useState(false);
	const [docxBusy, setDocxBusy] = useState(false);
	const [showDiff, setShowDiff] = useState(false);
	const canDiff = !!(baseMarkdown && screenplayId && versionId);

	function downloadMd() {
		const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}${versionLabel ? `-${versionLabel}` : ""}.md`;
		a.click();
		URL.revokeObjectURL(url);
	}

	async function downloadDocx() {
		setDocxBusy(true);
		try {
			// Dynamic import keeps the ~150KB docx lib out of the (already heavy)
			// screenplay route's initial bundle — loaded only on first click.
			const { buildScreenplayDocx } = await import("@/lib/screenplay/screenplay-docx");
			const blob = await buildScreenplayDocx(markdown, title);
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}${versionLabel ? `-${versionLabel}` : ""}.docx`;
			a.click();
			URL.revokeObjectURL(url);
		} finally {
			setDocxBusy(false);
		}
	}

	async function copyMd() {
		await navigator.clipboard.writeText(markdown);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}

	const chars = markdown.length;

	return (
		<Card className="border-border overflow-hidden">
			{/* toolbar */}
			<div className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-card/95 backdrop-blur-sm border-b border-border px-4 py-2.5">
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onPrev}
						disabled={!hasPrev}
						title={prevLabel ? `前のバージョン (第 ${prevLabel.replace("v", "")} 稿)` : "前のバージョン"}
						className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-foreground hover:text-foreground hover:bg-muted rounded-md disabled:text-muted-foreground disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
					>
						<ChevronLeft size={14} />
						前へ
					</button>
					<button
						type="button"
						onClick={onNext}
						disabled={!hasNext}
						title={nextLabel ? `次のバージョン (第 ${nextLabel.replace("v", "")} 稿)` : "次のバージョン"}
						className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-foreground hover:text-foreground hover:bg-muted rounded-md disabled:text-muted-foreground disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
					>
						次へ
						<ChevronRight size={14} />
					</button>
				</div>

				<div className="flex items-baseline gap-3 text-xs text-muted-foreground min-w-0 overflow-hidden">
					{versionLabel && <span className="font-semibold text-foreground">{versionLabel}</span>}
					{createdAt && <span className="tabular-nums truncate">{formatStamp(createdAt)}</span>}
					<span className="tabular-nums hidden sm:inline">{chars.toLocaleString()} 文字</span>
				</div>

				<div className="flex items-center gap-1">
					{canDiff && (
						<button
							type="button"
							onClick={() => setShowDiff((v) => !v)}
							className={[
								"inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-md transition-colors",
								showDiff ? "bg-blue-600/15 text-blue-700 dark:text-blue-300" : "text-foreground hover:bg-muted",
							].join(" ")}
						>
							<GitCompare size={12} />
							{showDiff ? "完成版" : "変更点"}
						</button>
					)}
					<button
						type="button"
						onClick={copyMd}
						className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
					>
						{copied ? <Check size={12} /> : <Copy size={12} />}
						{copied ? "コピー済み" : "コピー"}
					</button>
					<button
						type="button"
						onClick={downloadMd}
						className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
					>
						<Download size={12} />
						.md
					</button>
					<button
						type="button"
						onClick={downloadDocx}
						disabled={docxBusy}
						className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
					>
						<FileText size={12} />
						{docxBusy ? "生成中…" : "Word"}
					</button>
				</div>
			</div>

			<div className="px-6 py-8 lg:px-10 lg:py-10">
				{showDiff && canDiff ? (
					<ChangeDiffView
						baseMarkdown={baseMarkdown!}
						markdown={markdown}
						screenplayId={screenplayId!}
						versionId={versionId!}
					/>
				) : (
					<ScreenplayMarkdown markdown={markdown} />
				)}
			</div>
		</Card>
	);
}
