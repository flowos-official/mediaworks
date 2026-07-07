"use client";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import {
	Sparkles,
	Loader2,
	ArrowRight,
	Upload,
	Link2,
	FileText,
	FileSpreadsheet,
	Image as ImageIcon,
	CheckCircle2,
	AlertCircle,
	X,
	Wand2,
	Globe,
	RotateCcw,
} from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";
import { ProductBriefEditor } from "./ProductBriefEditor";

type InputMode = "upload" | "url";
type Step = 1 | 2 | 3;

interface PriceShape { listJpy?: number; saleJpy?: number; shippingJpy?: number }
interface ExtractedBrief {
	name: string;
	category?: string;
	description: string;
	price?: PriceShape;
	bonuses?: string[];
	guarantee?: string;
	notes?: string;
}

interface SourceMeta {
	kind: "pdf" | "image" | "excel" | "url";
	fileName?: string;
	url?: string;
	finalUrl?: string;
	imageCount?: number;
	size?: number;
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

function FileBadgeIcon({ name, className = "" }: { name: string; className?: string }) {
	const lower = name.toLowerCase();
	if (lower.endsWith(".pdf"))
		return <FileText size={16} className={`text-red-500 ${className}`} />;
	if (/\.(xlsx|xls|xlsm|ods)$/.test(lower))
		return <FileSpreadsheet size={16} className={`text-emerald-600 ${className}`} />;
	if (/\.(png|jpe?g|webp|heic|heif)$/.test(lower))
		return <ImageIcon size={16} className={`text-blue-500 ${className}`} />;
	return <FileText size={16} className={`text-muted-foreground ${className}`} />;
}

function formatBytes(b: number): string {
	if (b < 1024) return `${b} B`;
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
	return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ---- Stepper ----------------------------------------------------------------

function Stepper({ active }: { active: Step }) {
	const t = useTranslations("screenplay");
	const items: { n: Step; label: string; sub: string }[] = [
		{ n: 1, label: t("new.step.source"), sub: "Source" },
		{ n: 2, label: t("new.step.review"), sub: "Review" },
		{ n: 3, label: t("new.step.generate"), sub: "Generate" },
	];
	return (
		<ol className="flex items-stretch gap-0 mb-8 select-none" aria-label={t("a11y.createSteps")}>
			{items.map((it, i) => {
				const done = it.n < active;
				const current = it.n === active;
				return (
					<li key={it.n} className="flex-1 flex items-center">
						<div className="flex items-center gap-3 flex-1">
							<div
								className={[
									"relative flex items-center justify-center w-9 h-9 rounded-xl border text-xs font-semibold tabular-nums shrink-0 transition-all",
									done
										? "bg-blue-600 text-white border-blue-600 shadow-sm shadow-blue-200"
										: current
										? "bg-card text-blue-700 dark:text-blue-300 border-blue-500 ring-4 ring-blue-600/15"
										: "bg-card text-muted-foreground border-border",
								].join(" ")}
								aria-current={current ? "step" : undefined}
							>
								{done ? <CheckCircle2 size={16} /> : String(it.n).padStart(2, "0")}
							</div>
							<div className="min-w-0">
								<div
									className={[
										"text-[10px] uppercase tracking-[0.16em] font-semibold",
										current || done ? "text-blue-600/90" : "text-muted-foreground",
									].join(" ")}
								>
									Step {it.n}
								</div>
								<div
									className={[
										"text-sm font-medium",
										current ? "text-foreground" : done ? "text-foreground" : "text-muted-foreground",
									].join(" ")}
								>
									{it.label}
								</div>
							</div>
						</div>
						{i < items.length - 1 && (
							<div
								className={[
									"h-px flex-1 mx-3 transition-colors",
									done ? "bg-blue-500/70" : "bg-border",
								].join(" ")}
								aria-hidden
							/>
						)}
					</li>
				);
			})}
		</ol>
	);
}

// ---- Main component ---------------------------------------------------------

export function ScreenplayCreateForm({ locale }: { locale: string }) {
	const router = useRouter();
	const t = useTranslations("screenplay");
	const [mode, setMode] = useState<InputMode>("upload");
	const [extracting, setExtracting] = useState(false);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [dragOver, setDragOver] = useState(false);

	// Upload state
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);

	// URL state
	const [urlInput, setUrlInput] = useState("");

	// Extracted brief (editable preview)
	const [brief, setBrief] = useState<ExtractedBrief | null>(null);
	const [source, setSource] = useState<SourceMeta | null>(null);
	const [bonusesText, setBonusesText] = useState("");
	const [listPrice, setListPrice] = useState("");
	const [salePrice, setSalePrice] = useState("");
	const [shippingPrice, setShippingPrice] = useState("");

	const activeStep: Step = brief ? (submitting ? 3 : 2) : 1;

	function hydrateBrief(b: ExtractedBrief) {
		setBrief(b);
		setBonusesText((b.bonuses ?? []).join("\n"));
		setListPrice(priceToString(b.price?.listJpy));
		setSalePrice(priceToString(b.price?.saleJpy));
		setShippingPrice(priceToString(b.price?.shippingJpy));
	}

	function resetAll() {
		setBrief(null);
		setSource(null);
		setBonusesText("");
		setListPrice("");
		setSalePrice("");
		setShippingPrice("");
		setSelectedFile(null);
		setUrlInput("");
		setError(null);
		if (fileInputRef.current) fileInputRef.current.value = "";
	}

	async function runExtractUpload() {
		if (!selectedFile) return;
		setExtracting(true);
		setError(null);
		try {
			const form = new FormData();
			form.append("file", selectedFile);
			const res = await fetch("/api/screenplays/extract", { method: "POST", body: form });
			const j = await res.json();
			if (!res.ok) throw new Error(j.error ?? t("errors.extractFailed"));
			if (!j.brief || typeof j.brief !== "object") throw new Error(t("errors.noExtractResult"));
			hydrateBrief(j.brief as ExtractedBrief);
			setSource(j.source as SourceMeta);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setExtracting(false);
		}
	}

	async function runExtractUrl() {
		const trimmed = urlInput.trim();
		if (!trimmed) return;
		setExtracting(true);
		setError(null);
		try {
			const res = await fetch("/api/screenplays/extract", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ url: trimmed }),
			});
			const j = await res.json();
			if (!res.ok) throw new Error(j.error ?? t("errors.extractFailed"));
			if (!j.brief || typeof j.brief !== "object") throw new Error(t("errors.noExtractResult"));
			hydrateBrief(j.brief as ExtractedBrief);
			setSource(j.source as SourceMeta);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setExtracting(false);
		}
	}

	async function submit() {
		if (!brief) return;
		const name = brief.name.trim();
		const description = brief.description.trim();
		if (!name || !description) {
			setError(t("errors.nameDescRequired"));
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			const bonuses = bonusesText
				.split(/\r?\n/)
				.map((s) => s.trim())
				.filter(Boolean)
				.slice(0, 20);
			const price: PriceShape = {};
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
				body: JSON.stringify({
					productBrief,
					sourceKind: source?.kind === "url" ? "url" : source?.kind ? "upload" : undefined,
				}),
			});
			const j = await res.json();
			if (!res.ok) throw new Error(j.error ?? t("errors.createFailed"));
			router.push(localePath(locale, `/screenplays/${j.id}?run=${j.runId}`));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setSubmitting(false);
		}
	}

	// Drag-and-drop handlers (no behaviour change, just visual affordance).
	function onDropFiles(e: React.DragEvent<HTMLLabelElement>) {
		e.preventDefault();
		setDragOver(false);
		const f = e.dataTransfer.files?.[0];
		if (f) {
			setSelectedFile(f);
			setError(null);
		}
	}

	// Field shells -----------------------------------------------------------

	const inputCls =
		"w-full px-3.5 py-2.5 text-sm bg-card border border-border rounded-lg shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-4 focus:ring-blue-500/15 focus:border-blue-500 transition-shadow";

	// Render -----------------------------------------------------------------

	return (
		<div className="space-y-7">
			<Stepper active={activeStep} />

			{!brief && (
				<>
					{/* Mode picker — large, tactile cards instead of pill tabs */}
					<div className="grid grid-cols-1 md:grid-cols-2 gap-3" aria-label={t("a11y.inputMethod")}>
						<button
							type="button"
							aria-pressed={mode === "upload"}
							onClick={() => { setMode("upload"); setError(null); }}
							className={[
								"group relative text-left rounded-2xl border p-5 transition-all",
								mode === "upload"
									? "border-blue-500 bg-blue-600/10 ring-4 ring-blue-500/10 shadow-sm"
									: "border-border bg-card hover:border-border hover:bg-muted",
							].join(" ")}
						>
							<div className="flex items-start gap-3">
								<div
									className={[
										"w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-colors",
										mode === "upload" ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground group-hover:bg-accent",
									].join(" ")}
								>
									<Upload size={18} />
								</div>
								<div className="min-w-0">
									<div className="text-sm font-semibold text-foreground flex items-center gap-2">
										{t("new.mode.uploadTitle")}
										{mode === "upload" && (
											<span className="text-[10px] font-semibold tracking-[0.16em] uppercase text-blue-600">
												Selected
											</span>
										)}
									</div>
									<div className="text-xs text-muted-foreground mt-1">{t("new.mode.uploadDesc")}</div>
								</div>
							</div>
						</button>

						<button
							type="button"
							aria-pressed={mode === "url"}
							onClick={() => { setMode("url"); setError(null); }}
							className={[
								"group relative text-left rounded-2xl border p-5 transition-all",
								mode === "url"
									? "border-blue-500 bg-blue-600/10 ring-4 ring-blue-500/10 shadow-sm"
									: "border-border bg-card hover:border-border hover:bg-muted",
							].join(" ")}
						>
							<div className="flex items-start gap-3">
								<div
									className={[
										"w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-colors",
										mode === "url" ? "bg-blue-600 text-white" : "bg-muted text-muted-foreground group-hover:bg-accent",
									].join(" ")}
								>
									<Link2 size={18} />
								</div>
								<div className="min-w-0">
									<div className="text-sm font-semibold text-foreground flex items-center gap-2">
										{t("new.mode.urlTitle")}
										{mode === "url" && (
											<span className="text-[10px] font-semibold tracking-[0.16em] uppercase text-blue-600">
												Selected
											</span>
										)}
									</div>
									<div className="text-xs text-muted-foreground mt-1">{t("new.mode.urlDesc")}</div>
								</div>
							</div>
						</button>
					</div>

					{/* Active mode panel */}
					{mode === "upload" ? (
						<div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
							<div className="px-6 pt-5 pb-3 border-b border-border">
								<h2 className="text-base font-semibold text-foreground tracking-tight">
									{t("new.upload.heading")}
								</h2>
								<p className="text-xs text-muted-foreground mt-1">
									{t("new.upload.desc")}
								</p>
							</div>
							<div className="p-6 space-y-4">
								<label
									htmlFor="screenplay-file-input"
									onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
									onDragLeave={() => setDragOver(false)}
									onDrop={onDropFiles}
									className={[
										"relative flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed py-12 cursor-pointer transition-all overflow-hidden",
										dragOver
											? "border-blue-500 bg-blue-600/10"
											: "border-border hover:border-blue-400 hover:bg-blue-600/10",
									].join(" ")}
								>
									{/* Subtle grid texture for atmosphere */}
									<div
										aria-hidden
										className="absolute inset-0 opacity-[0.04] pointer-events-none"
										style={{
											backgroundImage:
												"linear-gradient(to right, #000 1px, transparent 1px), linear-gradient(to bottom, #000 1px, transparent 1px)",
											backgroundSize: "22px 22px",
										}}
									/>
									<div className="relative w-14 h-14 rounded-2xl bg-card shadow-sm border border-border flex items-center justify-center">
										<Upload size={22} className="text-blue-600" />
									</div>
									<div className="relative text-sm font-medium text-foreground">
										{selectedFile ? t("new.upload.changeFile") : t("new.upload.dropHint")}
									</div>
									<div className="relative flex items-center gap-1.5">
										{["PDF", "PNG/JPEG", "XLSX"].map((ext) => (
											<span
												key={ext}
												className="text-[10px] font-mono font-semibold tracking-wider text-muted-foreground bg-card border border-border px-1.5 py-0.5 rounded"
											>
												{ext}
											</span>
										))}
										<span className="text-[11px] text-muted-foreground ml-1">{t("new.upload.maxSize")}</span>
									</div>
									<input
										ref={fileInputRef}
										id="screenplay-file-input"
										type="file"
										accept=".pdf,.png,.jpg,.jpeg,.webp,.heic,.heif,.xlsx,.xls,.xlsm,.ods,application/pdf,image/*,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
										className="hidden"
										onChange={(e) => {
											const f = e.target.files?.[0] ?? null;
											setSelectedFile(f);
											setError(null);
										}}
									/>
								</label>

								{selectedFile && (
									<div className="flex items-center gap-3 p-3.5 bg-muted/80 border border-border rounded-xl">
										<div className="w-9 h-9 rounded-lg bg-card border border-border flex items-center justify-center shrink-0">
											<FileBadgeIcon name={selectedFile.name} />
										</div>
										<div className="flex-1 min-w-0">
											<div className="text-sm font-medium text-foreground truncate">{selectedFile.name}</div>
											<div className="text-[11px] text-muted-foreground tabular-nums">
												{formatBytes(selectedFile.size)}
												{selectedFile.type ? ` · ${selectedFile.type}` : ""}
											</div>
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

								<div className="flex items-center justify-between gap-3 pt-1">
									<p className="text-[11px] text-muted-foreground leading-relaxed">
										{t("new.extractHint")}
									</p>
									<button
										type="button"
										onClick={runExtractUpload}
										disabled={!selectedFile || extracting}
										className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium pl-4 pr-5 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-blue-200/60"
									>
										{extracting ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
										{extracting ? t("new.upload.extracting") : t("new.upload.extractBtn")}
									</button>
								</div>
							</div>
						</div>
					) : (
						<div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
							<div className="px-6 pt-5 pb-3 border-b border-border">
								<h2 className="text-base font-semibold text-foreground tracking-tight">
									{t("new.url.heading")}
								</h2>
								<p className="text-xs text-muted-foreground mt-1">
									{t("new.url.desc")}
								</p>
							</div>
							<div className="p-6 space-y-4">
								<div className="relative">
									<Globe
										size={16}
										className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
									/>
									<input
										type="url"
										value={urlInput}
										onChange={(e) => { setUrlInput(e.target.value); setError(null); }}
										placeholder="https://www.example.com/products/..."
										className={`${inputCls} pl-10 font-mono`}
									/>
								</div>
								<div className="flex items-center gap-2 text-[11px] text-muted-foreground">
									<span className="inline-flex items-center gap-1">
										<span className="w-1 h-1 rounded-full bg-emerald-400" />
										{t("new.url.protocolHint")}
									</span>
									<span className="text-muted-foreground">·</span>
									<span>{t("new.url.jsHint")}</span>
								</div>

								<div className="flex items-center justify-between gap-3 pt-1">
									<p className="text-[11px] text-muted-foreground leading-relaxed">
										{t("new.extractHint")}
									</p>
									<button
										type="button"
										onClick={runExtractUrl}
										disabled={!urlInput.trim() || extracting}
										className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium pl-4 pr-5 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-blue-200/60"
									>
										{extracting ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
										{extracting ? t("new.url.extracting") : t("new.url.extractBtn")}
									</button>
								</div>
							</div>
						</div>
					)}
				</>
			)}

			{brief && (
				<div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
					{/* Header strip */}
					<div className="relative px-6 pt-5 pb-4 border-b border-border bg-gradient-to-b from-emerald-600/10 to-transparent">
						<div className="flex items-start justify-between gap-4">
							<div className="min-w-0">
								<div className="inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.16em] uppercase text-emerald-700 dark:text-emerald-300 bg-emerald-600/10 border border-emerald-200/80 rounded-full px-2 py-0.5">
									<CheckCircle2 size={12} />
									{t("new.review.badge")}
								</div>
								<h2 className="text-base font-semibold text-foreground tracking-tight mt-2">
									{t("new.review.heading")}
								</h2>
								<p className="text-xs text-muted-foreground mt-1 max-w-xl">
									{t("new.review.desc")}
								</p>
							</div>
							<button
								type="button"
								onClick={resetAll}
								className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground underline-offset-2 hover:underline shrink-0 transition-colors"
							>
								<RotateCcw size={12} />
								{t("new.review.reextract")}
							</button>
						</div>
					</div>

					{/* Source breadcrumb */}
					{source && (
						<div className="px-6 py-3 border-b border-border bg-muted/40 flex items-center gap-2 text-xs">
							{source.kind === "url" ? (
								<Link2 size={12} className="text-muted-foreground shrink-0" />
							) : (
								<FileBadgeIcon name={source.fileName ?? ""} className="!w-3 !h-3" />
							)}
							<span className="text-muted-foreground truncate font-mono">
								{source.kind === "url"
									? (source.finalUrl ?? source.url)
									: `${source.fileName} · ${source.kind}`}
							</span>
							{typeof source.imageCount === "number" && source.imageCount > 0 && (
								<span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase text-emerald-700 dark:text-emerald-300 bg-emerald-600/10 border border-emerald-200/80 rounded-full px-2 py-0.5 shrink-0">
									<ImageIcon size={10} />
									{t("new.review.imageAnalyzed", { count: source.imageCount })}
								</span>
							)}
						</div>
					)}

					{/* Fields */}
					<ProductBriefEditor
						brief={{
							name: brief.name,
							category: brief.category,
							description: brief.description,
							guarantee: brief.guarantee,
							notes: brief.notes,
						}}
						onBriefChange={(b) => setBrief((prev) => (prev ? { ...prev, ...b } : { ...b }))}
						bonusesText={bonusesText}
						onBonusesChange={setBonusesText}
						listPrice={listPrice}
						salePrice={salePrice}
						shippingPrice={shippingPrice}
						onListPrice={setListPrice}
						onSalePrice={setSalePrice}
						onShippingPrice={setShippingPrice}
					/>
				</div>
			)}

			{error && (
				<div className="flex items-start gap-2.5 p-3.5 bg-red-600/10 border border-red-200/80 rounded-xl text-sm text-red-700 dark:text-red-300 shadow-sm">
					<AlertCircle size={16} className="shrink-0 mt-0.5 text-red-500" />
					<div className="leading-relaxed">{error}</div>
				</div>
			)}

			{brief && (
				<div className="sticky bottom-4 z-10">
					<div className="flex items-center justify-between gap-4 bg-card/95 backdrop-blur-md border border-border rounded-2xl shadow-lg shadow-gray-900/[0.04] p-4 ring-1 ring-black/[0.02]">
						<div className="min-w-0 flex-1 flex items-center gap-3">
							<div className="hidden sm:flex w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 items-center justify-center shrink-0 shadow-sm shadow-blue-200/60">
								<Sparkles size={16} className="text-white" />
							</div>
							<div className="min-w-0">
								<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground">
									{t("new.submit.target")}
								</div>
								<div className="text-sm font-semibold text-foreground truncate mt-0.5">
									{brief.name || t("new.submit.noName")}
								</div>
								<div className="text-[11px] text-muted-foreground mt-0.5">
									{t("new.submit.note")}
								</div>
							</div>
						</div>
						<button
							type="button"
							onClick={submit}
							disabled={!brief.name.trim() || !brief.description.trim() || submitting}
							className="inline-flex items-center gap-2 bg-gray-900 hover:bg-black active:bg-gray-900 text-white text-sm font-medium pl-5 pr-4 py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shrink-0 shadow-sm hover:shadow-md"
						>
							{submitting ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
							{submitting ? t("new.submit.submitting") : t("new.submit.submitBtn")}
							{!submitting && <ArrowRight size={14} className="opacity-70" />}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
