"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
	Check,
	ChevronLeft,
	ChevronRight,
	Copy,
	Download,
	FileText,
	PencilLine,
	ShieldAlert,
	ShieldCheck,
} from "lucide-react";
import { parseMarkdown } from "@/lib/screenplay/parse-markdown";
import { READINESS_LABEL_JA, type ReadinessSummary } from "@/lib/screenplay/readiness";

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
	readiness: ReadinessSummary;
	onEdit?: () => void;
	editing?: boolean;
}

function pad(n: number, w: number): string {
	return n.toString().padStart(w, "0");
}

function renderedTextLength(md: string): number {
	const strip = (value: string) => value.replace(/\s/g, "").length;
	let count = 0;
	for (const block of parseMarkdown(md)) {
		if (block.kind === "heading") count += strip(block.text);
		else if (block.kind === "para") count += strip(block.text);
		else if (block.kind === "cue") count += strip(block.lines.join(""));
		else if (block.kind === "speaker") count += strip((block.delivery ?? "") + block.jp + (block.en ?? ""));
		else if (block.kind === "list") count += strip(block.items.join(""));
		else if (block.kind === "table") count += strip(block.rows.flat().join(""));
	}
	return count;
}

function formatStamp(iso?: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	return `${date.getFullYear()}/${pad(date.getMonth() + 1, 2)}/${pad(date.getDate(), 2)} ${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}`;
}

export function ScreenplayHeaderBar({
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
	readiness,
	onEdit,
	editing = false,
}: Props) {
	const t = useTranslations("screenplay.workspace");
	const [copied, setCopied] = useState(false);
	const [docxBusy, setDocxBusy] = useState(false);
	const chars = useMemo(() => renderedTextLength(markdown), [markdown]);
	const safeName = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}${versionLabel ? `-${versionLabel.replace(/\s+/g, "")}` : ""}`;
	const isDraftExport = readiness.state !== "ready";
	const readinessClass =
		readiness.state === "blocked" || readiness.state === "failed"
			? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
			: readiness.state === "review" || readiness.state === "draft"
				? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
				: readiness.state === "generating"
					? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
					: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";

	function downloadMd() {
		const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `${safeName}.md`;
		anchor.click();
		URL.revokeObjectURL(url);
	}

	async function downloadDocx() {
		setDocxBusy(true);
		try {
			const { buildScreenplayDocx } = await import("@/lib/screenplay/screenplay-docx");
			const blob = await buildScreenplayDocx(
				markdown,
				title,
				isDraftExport ? "未承認・下書き" : "承認用台本",
			);
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `${safeName}.docx`;
			anchor.click();
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

	return (
		<div className="z-20 mb-4 rounded-xl border border-border bg-card/95 px-3 py-2.5 shadow-sm backdrop-blur-sm sm:sticky sm:top-16">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<h1 className="max-w-[42rem] truncate text-sm font-semibold text-foreground sm:text-base">{title}</h1>
						<span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${readinessClass}`}>
							{readiness.state === "ready" ? <ShieldCheck size={10} /> : <ShieldAlert size={10} />}
							{READINESS_LABEL_JA[readiness.state]}
						</span>
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground">
						{versionLabel && <span>{versionLabel}</span>}
						{createdAt && <span>{formatStamp(createdAt)}</span>}
						<span>{t("chars", { n: chars.toLocaleString() })}</span>
						{readiness.total > 0 && <span>{readiness.high} blockers · {readiness.total} findings</span>}
					</div>
				</div>

				<div className="grid w-full grid-cols-3 gap-1 sm:flex sm:w-auto sm:items-center">
					{onEdit && (
						<button
							type="button"
							onClick={onEdit}
							className="inline-flex min-h-10 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted sm:min-h-0 sm:px-3"
						>
							<PencilLine size={12} /> {editing ? "編集を終了" : "本文を編集"}
						</button>
					)}
					<button
						type="button"
						onClick={copyMd}
						title={isDraftExport ? "未承認の下書きとしてコピーします" : undefined}
						className="inline-flex min-h-10 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs text-foreground transition hover:bg-muted sm:min-h-0 sm:px-3"
					>
						{copied ? <Check size={12} /> : <Copy size={12} />}
						{copied ? t("copied") : isDraftExport ? "下書きコピー" : t("copy")}
					</button>
					<button
						type="button"
						onClick={downloadMd}
						title={isDraftExport ? "未承認の下書きとして書き出します" : undefined}
						className="hidden items-center gap-1 rounded-md px-3 py-1.5 text-xs text-foreground transition hover:bg-muted sm:inline-flex"
					>
						<Download size={12} /> .md
					</button>
					<button
						type="button"
						onClick={downloadDocx}
						disabled={docxBusy}
						title={isDraftExport ? "未承認の下書きとして書き出します" : undefined}
						className="inline-flex min-h-10 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:px-3"
					>
						<FileText size={12} /> {docxBusy ? t("generating") : isDraftExport ? "下書きWord" : "Word"}
					</button>
				</div>
			</div>

			<div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2">
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={onPrev}
						disabled={!hasPrev}
						title={prevLabel ? t("prevVersionWithDraft", { n: prevLabel.replace("v", "") }) : t("prevVersion")}
						className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent"
					>
						<ChevronLeft size={14} /> {t("prev")}
					</button>
					<button
						type="button"
						onClick={onNext}
						disabled={!hasNext}
						title={nextLabel ? t("nextVersionWithDraft", { n: nextLabel.replace("v", "") }) : t("nextVersion")}
						className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent"
					>
						{t("next")} <ChevronRight size={14} />
					</button>
				</div>
				<div className="text-[10px] text-muted-foreground">
					{readiness.state === "ready" ? "最終承認後に本番使用" : "指摘を解消してから本番使用"}
				</div>
			</div>
		</div>
	);
}
