"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import {
	Upload, Loader2, FileText, X, Wand2, AlertCircle, CheckCircle2,
	RotateCcw, Sparkles, ArrowRight, ChevronDown, ChevronUp,
} from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";
import { ProductBriefEditor, type BriefDraft } from "./ProductBriefEditor";
import { ScreenplayMarkdown } from "./markdown-renderer";

interface ExtractedBrief extends BriefDraft {
	price?: { listJpy?: number; saleJpy?: number; shippingJpy?: number };
	bonuses?: string[];
}

function priceToString(n: number | undefined): string {
	return typeof n === "number" && Number.isFinite(n) ? String(n) : "";
}
function parsePrice(s: string): number | undefined {
	const cleaned = s.replace(/[, ¥円\s]/g, "");
	if (!cleaned) return undefined;
	const n = Number(cleaned);
	return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}
function formatBytes(b: number): string {
	if (b < 1024) return `${b} B`;
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
	return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function ScreenplayImportForm({ locale }: { locale: string }) {
	const router = useRouter();
	const t = useTranslations("screenplay");
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [extracting, setExtracting] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dragOver, setDragOver] = useState(false);

	const [markdown, setMarkdown] = useState<string | null>(null);
	const [brief, setBrief] = useState<BriefDraft | null>(null);
	const [bonusesText, setBonusesText] = useState("");
	const [listPrice, setListPrice] = useState("");
	const [salePrice, setSalePrice] = useState("");
	const [shippingPrice, setShippingPrice] = useState("");
	const [showPreview, setShowPreview] = useState(false);

	function hydrate(b: ExtractedBrief, md: string) {
		setBrief({ name: b.name, category: b.category, description: b.description, guarantee: b.guarantee, notes: b.notes });
		setBonusesText((b.bonuses ?? []).join("\n"));
		setListPrice(priceToString(b.price?.listJpy));
		setSalePrice(priceToString(b.price?.saleJpy));
		setShippingPrice(priceToString(b.price?.shippingJpy));
		setMarkdown(md);
	}

	function resetAll() {
		setSelectedFile(null);
		setMarkdown(null);
		setBrief(null);
		setBonusesText("");
		setListPrice("");
		setSalePrice("");
		setShippingPrice("");
		setError(null);
		if (fileInputRef.current) fileInputRef.current.value = "";
	}

	async function runImport() {
		if (!selectedFile) return;
		setExtracting(true);
		setError(null);
		try {
			if (!selectedFile.name.toLowerCase().endsWith(".docx")) {
				throw new Error(t("errors.docxOnly"));
			}
			if (selectedFile.size > 25 * 1024 * 1024) {
				throw new Error(t("errors.fileTooLarge"));
			}

			// Parse the .docx to text IN THE BROWSER, then POST only the text. Large,
			// image-heavy Word files (which the script text is a tiny fraction of)
			// would otherwise exceed the serverless request-body limit on upload.
			const arrayBuffer = await selectedFile.arrayBuffer();
			let text: string;
			try {
				const mod = (await import("mammoth")) as typeof import("mammoth") & {
					default?: typeof import("mammoth");
				};
				const extractRawText = mod.extractRawText ?? mod.default?.extractRawText;
				if (!extractRawText) throw new Error("mammoth unavailable");
				const out = await extractRawText({ arrayBuffer });
				text = (out.value ?? "").trim();
			} catch {
				throw new Error(t("errors.docxUnreadable"));
			}
			if (!text) {
				throw new Error(t("errors.docxEmpty"));
			}

			const res = await fetch("/api/screenplays/import", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text, fileName: selectedFile.name }),
			});
			let j: { error?: string; brief?: ExtractedBrief; markdown?: string };
			try {
				j = await res.json();
			} catch {
				throw new Error(res.ok ? t("errors.serverResponseParse") : t("errors.importFailedHttp", { status: res.status }));
			}
			if (!res.ok) throw new Error(j.error ?? t("errors.importFailed"));
			if (!j.brief || typeof j.markdown !== "string") throw new Error(t("errors.noImportResult"));
			hydrate(j.brief, j.markdown);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setExtracting(false);
		}
	}

	async function submit() {
		if (!brief || !markdown) return;
		const name = brief.name.trim();
		const description = brief.description.trim();
		if (!name || !description) {
			setError(t("errors.nameDescRequired"));
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const bonuses = bonusesText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
			const price: ExtractedBrief["price"] = {};
			const list = parsePrice(listPrice);
			const sale = parsePrice(salePrice);
			const ship = parsePrice(shippingPrice);
			if (list !== undefined) price.listJpy = list;
			if (sale !== undefined) price.saleJpy = sale;
			if (ship !== undefined) price.shippingJpy = ship;

			const productBrief: ExtractedBrief = { name, description };
			if (brief.category?.trim()) productBrief.category = brief.category.trim();
			if (brief.guarantee?.trim()) productBrief.guarantee = brief.guarantee.trim();
			if (brief.notes?.trim()) productBrief.notes = brief.notes.trim();
			if (bonuses.length) productBrief.bonuses = bonuses;
			if (Object.keys(price).length) productBrief.price = price;

			const res = await fetch("/api/screenplays", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ productBrief, importedMarkdown: markdown }),
			});
			const j = await res.json();
			if (!res.ok) throw new Error(j.error ?? t("errors.createFailed"));
			router.push(localePath(locale, `/screenplays/${j.id}?run=${j.runId}&kind=import`));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setSubmitting(false);
		}
	}

	function onDropFiles(e: React.DragEvent<HTMLLabelElement>) {
		e.preventDefault();
		setDragOver(false);
		const f = e.dataTransfer.files?.[0];
		if (f) { setSelectedFile(f); setError(null); }
	}

	return (
		<div className="space-y-7">
			{!brief && (
				<div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
					<div className="px-6 pt-5 pb-3 border-b border-border">
						<h2 className="text-base font-semibold text-foreground tracking-tight">{t("import.heading")}</h2>
						<p className="text-xs text-muted-foreground mt-1">
							{t("import.desc")}
						</p>
					</div>
					<div className="p-6 space-y-4">
						<label
							htmlFor="screenplay-import-input"
							onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
							onDragLeave={() => setDragOver(false)}
							onDrop={onDropFiles}
							className={[
								"relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed py-12 cursor-pointer transition-all",
								dragOver ? "border-blue-500 bg-blue-600/10" : "border-border hover:border-blue-400 hover:bg-blue-600/10",
							].join(" ")}
						>
							<div className="relative w-14 h-14 rounded-2xl bg-card shadow-sm border border-border flex items-center justify-center">
								<Upload size={22} className="text-blue-600" />
							</div>
							<div className="relative text-sm font-medium text-foreground">
								{selectedFile ? t("import.changeFile") : t("import.dropHint")}
							</div>
							<div className="relative flex items-center gap-1.5">
								<span className="text-[10px] font-mono font-semibold tracking-wider text-muted-foreground bg-card border border-border px-1.5 py-0.5 rounded">DOCX</span>
								<span className="text-[11px] text-muted-foreground ml-1">{t("import.maxSize")}</span>
							</div>
							<input
								ref={fileInputRef}
								id="screenplay-import-input"
								type="file"
								accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
								className="hidden"
								onChange={(e) => { setSelectedFile(e.target.files?.[0] ?? null); setError(null); }}
							/>
						</label>

						{selectedFile && (
							<div className="flex items-center gap-3 p-3.5 bg-muted/80 border border-border rounded-xl">
								<div className="w-9 h-9 rounded-lg bg-card border border-border flex items-center justify-center shrink-0">
									<FileText size={16} className="text-blue-500" />
								</div>
								<div className="flex-1 min-w-0">
									<div className="text-sm font-medium text-foreground truncate">{selectedFile.name}</div>
									<div className="text-[11px] text-muted-foreground tabular-nums">{formatBytes(selectedFile.size)}</div>
								</div>
								<button
									type="button"
									onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
									className="text-muted-foreground hover:text-foreground p-1.5 rounded-md hover:bg-card transition-colors"
									aria-label={t("a11y.removeFile")}
								>
									<X size={14} />
								</button>
							</div>
						)}

						<div className="flex items-center justify-end pt-1">
							<button
								type="button"
								onClick={runImport}
								disabled={!selectedFile || extracting}
								className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium pl-4 pr-5 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-blue-200/60"
							>
								{extracting ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
								{extracting ? t("import.importing") : t("import.importBtn")}
							</button>
						</div>
					</div>
				</div>
			)}

			{brief && markdown && (
				<div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
					<div className="relative px-6 pt-5 pb-4 border-b border-border bg-gradient-to-b from-emerald-600/10 to-transparent">
						<div className="flex items-start justify-between gap-4">
							<div className="min-w-0">
								<div className="inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.16em] uppercase text-emerald-700 dark:text-emerald-300 bg-emerald-600/10 border border-emerald-200/80 rounded-full px-2 py-0.5">
									<CheckCircle2 size={12} />
									{t("import.doneBadge")}
								</div>
								<h2 className="text-base font-semibold text-foreground tracking-tight mt-2">{t("import.reviewHeading")}</h2>
								<p className="text-xs text-muted-foreground mt-1 max-w-xl">
									{t("import.reviewDesc")}
								</p>
							</div>
							<button
								type="button"
								onClick={resetAll}
								className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline shrink-0 transition-colors"
							>
								<RotateCcw size={12} />
								{t("import.reimport")}
							</button>
						</div>
					</div>

					<ProductBriefEditor
						brief={brief}
						onBriefChange={setBrief}
						bonusesText={bonusesText}
						onBonusesChange={setBonusesText}
						listPrice={listPrice}
						salePrice={salePrice}
						shippingPrice={shippingPrice}
						onListPrice={setListPrice}
						onSalePrice={setSalePrice}
						onShippingPrice={setShippingPrice}
					/>

					<div className="px-6 pb-6">
						<button
							type="button"
							onClick={() => setShowPreview((v) => !v)}
							className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
						>
							{showPreview ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
							{t("import.previewToggle")}
						</button>
						{showPreview && (
							<div className="mt-3 max-h-[480px] overflow-y-auto rounded-xl border border-border bg-muted/30 p-5">
								<ScreenplayMarkdown markdown={markdown} />
							</div>
						)}
					</div>
				</div>
			)}

			{error && (
				<div className="flex items-start gap-2.5 p-3.5 bg-red-600/10 border border-red-200/80 rounded-xl text-sm text-red-700 dark:text-red-300 shadow-sm">
					<AlertCircle size={16} className="shrink-0 mt-0.5 text-red-500" />
					<div className="leading-relaxed">{error}</div>
				</div>
			)}

			{brief && markdown && (
				<div className="sticky bottom-4 z-10">
					<div className="flex items-center justify-between gap-4 bg-card/95 backdrop-blur-md border border-border rounded-2xl shadow-lg p-4">
						<div className="min-w-0 flex-1 flex items-center gap-3">
							<div className="hidden sm:flex w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 items-center justify-center shrink-0">
								<Sparkles size={16} className="text-white" />
							</div>
							<div className="min-w-0">
								<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground">{t("import.target")}</div>
								<div className="text-sm font-semibold text-foreground truncate mt-0.5">{brief.name || t("import.noName")}</div>
								<div className="text-[11px] text-muted-foreground mt-0.5">{t("import.submitNote")}</div>
							</div>
						</div>
						<button
							type="button"
							onClick={submit}
							disabled={!brief.name.trim() || !brief.description.trim() || submitting}
							className="inline-flex items-center gap-2 bg-gray-900 hover:bg-black text-white text-sm font-medium pl-5 pr-4 py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shrink-0 shadow-sm"
						>
							{submitting ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
							{submitting ? t("import.submitting") : t("import.submitBtn")}
							{!submitting && <ArrowRight size={14} className="opacity-70" />}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
