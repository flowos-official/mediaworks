"use client";
import { useRouter } from "next/navigation";
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
	return <FileText size={16} className={`text-gray-500 ${className}`} />;
}

function formatBytes(b: number): string {
	if (b < 1024) return `${b} B`;
	if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
	return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ---- Stepper ----------------------------------------------------------------

function Stepper({ active }: { active: Step }) {
	const items: { n: Step; label: string; sub: string }[] = [
		{ n: 1, label: "ソース", sub: "Source" },
		{ n: 2, label: "確認", sub: "Review" },
		{ n: 3, label: "生成", sub: "Generate" },
	];
	return (
		<ol className="flex items-stretch gap-0 mb-8 select-none" aria-label="作成ステップ">
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
										? "bg-white text-blue-700 border-blue-500 ring-4 ring-blue-100"
										: "bg-white text-gray-400 border-gray-200",
								].join(" ")}
								aria-current={current ? "step" : undefined}
							>
								{done ? <CheckCircle2 size={16} /> : String(it.n).padStart(2, "0")}
							</div>
							<div className="min-w-0">
								<div
									className={[
										"text-[10px] uppercase tracking-[0.16em] font-semibold",
										current || done ? "text-blue-600/90" : "text-gray-400",
									].join(" ")}
								>
									Step {it.n}
								</div>
								<div
									className={[
										"text-sm font-medium",
										current ? "text-gray-900" : done ? "text-gray-700" : "text-gray-400",
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
									done ? "bg-blue-500/70" : "bg-gray-200",
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
			if (!res.ok) throw new Error(j.error ?? "抽出に失敗しました");
			if (!j.brief || typeof j.brief !== "object") throw new Error("サーバーから抽出結果が返りませんでした");
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
			if (!res.ok) throw new Error(j.error ?? "抽出に失敗しました");
			if (!j.brief || typeof j.brief !== "object") throw new Error("サーバーから抽出結果が返りませんでした");
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
			setError("商品名と特徴・スペックは必須です");
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
				body: JSON.stringify({ productBrief }),
			});
			const j = await res.json();
			if (!res.ok) throw new Error(j.error ?? "作成に失敗しました");
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
		"w-full px-3.5 py-2.5 text-sm bg-white border border-gray-200 rounded-lg shadow-sm placeholder:text-gray-400 focus:outline-none focus:ring-4 focus:ring-blue-500/15 focus:border-blue-500 transition-shadow";

	// Render -----------------------------------------------------------------

	return (
		<div className="space-y-7">
			<Stepper active={activeStep} />

			{!brief && (
				<>
					{/* Mode picker — large, tactile cards instead of pill tabs */}
					<div className="grid grid-cols-1 md:grid-cols-2 gap-3" aria-label="入力方法">
						<button
							type="button"
							aria-pressed={mode === "upload"}
							onClick={() => { setMode("upload"); setError(null); }}
							className={[
								"group relative text-left rounded-2xl border p-5 transition-all",
								mode === "upload"
									? "border-blue-500 bg-blue-50/30 ring-4 ring-blue-500/10 shadow-sm"
									: "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50/60",
							].join(" ")}
						>
							<div className="flex items-start gap-3">
								<div
									className={[
										"w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-colors",
										mode === "upload" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500 group-hover:bg-gray-200",
									].join(" ")}
								>
									<Upload size={18} />
								</div>
								<div className="min-w-0">
									<div className="text-sm font-semibold text-gray-900 flex items-center gap-2">
										ファイルをアップロード
										{mode === "upload" && (
											<span className="text-[10px] font-semibold tracking-[0.16em] uppercase text-blue-600">
												Selected
											</span>
										)}
									</div>
									<div className="text-xs text-gray-500 mt-1">PDF / Excel / 画像 を Gemini Vision が解析</div>
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
									? "border-blue-500 bg-blue-50/30 ring-4 ring-blue-500/10 shadow-sm"
									: "border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50/60",
							].join(" ")}
						>
							<div className="flex items-start gap-3">
								<div
									className={[
										"w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-colors",
										mode === "url" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-500 group-hover:bg-gray-200",
									].join(" ")}
								>
									<Link2 size={18} />
								</div>
								<div className="min-w-0">
									<div className="text-sm font-semibold text-gray-900 flex items-center gap-2">
										商品ページURL
										{mode === "url" && (
											<span className="text-[10px] font-semibold tracking-[0.16em] uppercase text-blue-600">
												Selected
											</span>
										)}
									</div>
									<div className="text-xs text-gray-500 mt-1">公開URLの本文＋商品画像を自動取得</div>
								</div>
							</div>
						</button>
					</div>

					{/* Active mode panel */}
					{mode === "upload" ? (
						<div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
							<div className="px-6 pt-5 pb-3 border-b border-gray-100">
								<h2 className="text-base font-semibold text-gray-900 tracking-tight">
									PDF / Excel / 画像をアップロード
								</h2>
								<p className="text-xs text-gray-500 mt-1">
									商品資料 (PDF / 画像 / Excel) を1ファイル選択してください。Gemini が内容を読み取り、台本生成用の商品情報を抽出します。
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
											? "border-blue-500 bg-blue-50/60"
											: "border-gray-300 hover:border-blue-400 hover:bg-blue-50/30",
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
									<div className="relative w-14 h-14 rounded-2xl bg-white shadow-sm border border-gray-200 flex items-center justify-center">
										<Upload size={22} className="text-blue-600" />
									</div>
									<div className="relative text-sm font-medium text-gray-700">
										{selectedFile ? "別のファイルに変更" : "クリックしてファイルを選択 — またはドラッグ＆ドロップ"}
									</div>
									<div className="relative flex items-center gap-1.5">
										{["PDF", "PNG/JPEG", "XLSX"].map((ext) => (
											<span
												key={ext}
												className="text-[10px] font-mono font-semibold tracking-wider text-gray-500 bg-white border border-gray-200 px-1.5 py-0.5 rounded"
											>
												{ext}
											</span>
										))}
										<span className="text-[11px] text-gray-400 ml-1">最大 25MB</span>
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
									<div className="flex items-center gap-3 p-3.5 bg-gray-50/80 border border-gray-200 rounded-xl">
										<div className="w-9 h-9 rounded-lg bg-white border border-gray-200 flex items-center justify-center shrink-0">
											<FileBadgeIcon name={selectedFile.name} />
										</div>
										<div className="flex-1 min-w-0">
											<div className="text-sm font-medium text-gray-900 truncate">{selectedFile.name}</div>
											<div className="text-[11px] text-gray-500 tabular-nums">
												{formatBytes(selectedFile.size)}
												{selectedFile.type ? ` · ${selectedFile.type}` : ""}
											</div>
										</div>
										<button
											type="button"
											onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
											className="text-gray-400 hover:text-gray-700 p-1.5 rounded-md hover:bg-white transition-colors"
											aria-label="ファイルを削除"
										>
											<X size={14} />
										</button>
									</div>
								)}

								<div className="flex items-center justify-between gap-3 pt-1">
									<p className="text-[11px] text-gray-400 leading-relaxed">
										抽出した情報は次の画面で確認・編集できます。
									</p>
									<button
										type="button"
										onClick={runExtractUpload}
										disabled={!selectedFile || extracting}
										className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium pl-4 pr-5 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-blue-200/60"
									>
										{extracting ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
										{extracting ? "抽出中..." : "Geminiで情報を抽出"}
									</button>
								</div>
							</div>
						</div>
					) : (
						<div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
							<div className="px-6 pt-5 pb-3 border-b border-gray-100">
								<h2 className="text-base font-semibold text-gray-900 tracking-tight">
									商品ページのURLから読み込む
								</h2>
								<p className="text-xs text-gray-500 mt-1">
									公開されている商品ページのURLを入力すると、本文と主要な画像 (最大4枚) を Gemini Vision が解析して商品情報を抽出します。
								</p>
							</div>
							<div className="p-6 space-y-4">
								<div className="relative">
									<Globe
										size={16}
										className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none"
									/>
									<input
										type="url"
										value={urlInput}
										onChange={(e) => { setUrlInput(e.target.value); setError(null); }}
										placeholder="https://www.example.com/products/..."
										className={`${inputCls} pl-10 font-mono`}
									/>
								</div>
								<div className="flex items-center gap-2 text-[11px] text-gray-400">
									<span className="inline-flex items-center gap-1">
										<span className="w-1 h-1 rounded-full bg-emerald-400" />
										http / https のみ
									</span>
									<span className="text-gray-200">·</span>
									<span>JavaScript非依存ページに最適</span>
								</div>

								<div className="flex items-center justify-between gap-3 pt-1">
									<p className="text-[11px] text-gray-400 leading-relaxed">
										抽出した情報は次の画面で確認・編集できます。
									</p>
									<button
										type="button"
										onClick={runExtractUrl}
										disabled={!urlInput.trim() || extracting}
										className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 active:bg-blue-800 text-white text-sm font-medium pl-4 pr-5 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-blue-200/60"
									>
										{extracting ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
										{extracting ? "解析中..." : "URLから情報を抽出"}
									</button>
								</div>
							</div>
						</div>
					)}
				</>
			)}

			{brief && (
				<div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
					{/* Header strip */}
					<div className="relative px-6 pt-5 pb-4 border-b border-gray-100 bg-gradient-to-b from-emerald-50/40 to-transparent">
						<div className="flex items-start justify-between gap-4">
							<div className="min-w-0">
								<div className="inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.16em] uppercase text-emerald-700 bg-emerald-50 border border-emerald-200/80 rounded-full px-2 py-0.5">
									<CheckCircle2 size={12} />
									抽出完了
								</div>
								<h2 className="text-base font-semibold text-gray-900 tracking-tight mt-2">
									抽出結果を確認・編集
								</h2>
								<p className="text-xs text-gray-500 mt-1 max-w-xl">
									内容に問題なければ「台本を生成」を押してください。修正したい項目があれば自由に編集できます。
								</p>
							</div>
							<button
								type="button"
								onClick={resetAll}
								className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-900 underline-offset-2 hover:underline shrink-0 transition-colors"
							>
								<RotateCcw size={12} />
								別の素材で再抽出
							</button>
						</div>
					</div>

					{/* Source breadcrumb */}
					{source && (
						<div className="px-6 py-3 border-b border-gray-100 bg-gray-50/40 flex items-center gap-2 text-xs">
							{source.kind === "url" ? (
								<Link2 size={12} className="text-gray-400 shrink-0" />
							) : (
								<FileBadgeIcon name={source.fileName ?? ""} className="!w-3 !h-3" />
							)}
							<span className="text-gray-500 truncate font-mono">
								{source.kind === "url"
									? (source.finalUrl ?? source.url)
									: `${source.fileName} · ${source.kind}`}
							</span>
							{typeof source.imageCount === "number" && source.imageCount > 0 && (
								<span className="ml-auto inline-flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase text-emerald-700 bg-emerald-50 border border-emerald-200/80 rounded-full px-2 py-0.5 shrink-0">
									<ImageIcon size={10} />
									画像 {source.imageCount} 枚を解析
								</span>
							)}
						</div>
					)}

					{/* Fields */}
					<div className="p-6 space-y-7">
						{/* Section: 基本情報 */}
						<section>
							<div className="flex items-center gap-3 mb-3">
								<h3 className="text-[10px] font-semibold tracking-[0.16em] uppercase text-gray-500">
									基本情報
								</h3>
								<div className="h-px flex-1 bg-gray-100" aria-hidden />
							</div>
							<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
								<div className="md:col-span-2">
									<label className="block text-xs font-medium text-gray-700 mb-1.5">
										商品名 <span className="text-red-500">*</span>
									</label>
									<input
										type="text"
										value={brief.name}
										onChange={(e) => setBrief({ ...brief, name: e.target.value })}
										className={inputCls}
										maxLength={200}
									/>
								</div>
								<div className="md:col-span-2">
									<label className="block text-xs font-medium text-gray-700 mb-1.5">カテゴリ</label>
									<input
										type="text"
										value={brief.category ?? ""}
										onChange={(e) => setBrief({ ...brief, category: e.target.value })}
										className={inputCls}
										maxLength={200}
									/>
								</div>
								<div className="md:col-span-2">
									<label className="block text-xs font-medium text-gray-700 mb-1.5">
										特徴・スペック <span className="text-red-500">*</span>
									</label>
									<textarea
										value={brief.description}
										onChange={(e) => setBrief({ ...brief, description: e.target.value })}
										rows={8}
										className={`${inputCls} resize-y leading-relaxed`}
										maxLength={16000}
									/>
									<div className="flex items-center justify-end mt-1">
										<p className="text-[11px] text-gray-400 tabular-nums">
											{brief.description.length.toLocaleString()} / 16,000 文字
										</p>
									</div>
								</div>
							</div>
						</section>

						{/* Section: 価格 */}
						<section>
							<div className="flex items-center gap-3 mb-3">
								<h3 className="text-[10px] font-semibold tracking-[0.16em] uppercase text-gray-500">
									価格
								</h3>
								<div className="h-px flex-1 bg-gray-100" aria-hidden />
							</div>
							<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
								<div>
									<label className="block text-xs font-medium text-gray-700 mb-1.5">メーカー直販価格</label>
									<div className="relative">
										<span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">¥</span>
										<input
											type="number"
											inputMode="numeric"
											value={listPrice}
											onChange={(e) => setListPrice(e.target.value)}
											min={0}
											className={`${inputCls} pl-7 tabular-nums`}
										/>
									</div>
								</div>
								<div>
									<label className="block text-xs font-medium text-gray-700 mb-1.5">本日特別価格</label>
									<div className="relative">
										<span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">¥</span>
										<input
											type="number"
											inputMode="numeric"
											value={salePrice}
											onChange={(e) => setSalePrice(e.target.value)}
											min={0}
											className={`${inputCls} pl-7 tabular-nums`}
										/>
									</div>
								</div>
								<div>
									<label className="block text-xs font-medium text-gray-700 mb-1.5">送料</label>
									<div className="relative">
										<span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">¥</span>
										<input
											type="number"
											inputMode="numeric"
											value={shippingPrice}
											onChange={(e) => setShippingPrice(e.target.value)}
											min={0}
											className={`${inputCls} pl-7 tabular-nums`}
										/>
									</div>
								</div>
							</div>
						</section>

						{/* Section: 特典・補足 */}
						<section>
							<div className="flex items-center gap-3 mb-3">
								<h3 className="text-[10px] font-semibold tracking-[0.16em] uppercase text-gray-500">
									特典・補足
								</h3>
								<div className="h-px flex-1 bg-gray-100" aria-hidden />
							</div>
							<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
								<div>
									<label className="block text-xs font-medium text-gray-700 mb-1.5">保証</label>
									<input
										type="text"
										value={brief.guarantee ?? ""}
										onChange={(e) => setBrief({ ...brief, guarantee: e.target.value })}
										className={inputCls}
										maxLength={500}
									/>
								</div>
								<div>
									<label className="block text-xs font-medium text-gray-700 mb-1.5">ボーナス・特典 (1行1件)</label>
									<textarea
										value={bonusesText}
										onChange={(e) => setBonusesText(e.target.value)}
										rows={3}
										className={`${inputCls} resize-none`}
									/>
								</div>
								<div className="md:col-span-2">
									<label className="block text-xs font-medium text-gray-700 mb-1.5">その他のメモ</label>
									<textarea
										value={brief.notes ?? ""}
										onChange={(e) => setBrief({ ...brief, notes: e.target.value })}
										rows={3}
										className={`${inputCls} resize-none`}
										maxLength={4000}
									/>
								</div>
							</div>
						</section>
					</div>
				</div>
			)}

			{error && (
				<div className="flex items-start gap-2.5 p-3.5 bg-red-50 border border-red-200/80 rounded-xl text-sm text-red-700 shadow-sm">
					<AlertCircle size={16} className="shrink-0 mt-0.5 text-red-500" />
					<div className="leading-relaxed">{error}</div>
				</div>
			)}

			{brief && (
				<div className="sticky bottom-4 z-10">
					<div className="flex items-center justify-between gap-4 bg-white/95 backdrop-blur-md border border-gray-200 rounded-2xl shadow-lg shadow-gray-900/[0.04] p-4 ring-1 ring-black/[0.02]">
						<div className="min-w-0 flex-1 flex items-center gap-3">
							<div className="hidden sm:flex w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 items-center justify-center shrink-0 shadow-sm shadow-blue-200/60">
								<Sparkles size={16} className="text-white" />
							</div>
							<div className="min-w-0">
								<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-gray-400">
									生成対象
								</div>
								<div className="text-sm font-semibold text-gray-900 truncate mt-0.5">
									{brief.name || "(商品名未入力)"}
								</div>
								<div className="text-[11px] text-gray-400 mt-0.5">
									生成には約2〜6分かかります。完了後にフィードバックで改稿できます。
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
							{submitting ? "作成中..." : "台本を生成"}
							{!submitting && <ArrowRight size={14} className="opacity-70" />}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
