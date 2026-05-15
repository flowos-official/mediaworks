"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Sparkles, Search, X, Package, Loader2, CheckCircle, ArrowRight, PencilLine, ListChecks } from "lucide-react";

type ProductRow = {
	id: string;
	name: string;
	description: string | null;
	category: string | null;
	status: string;
	created_at: string;
};

type Mode = "picker" | "manual";

export function ScreenplayCreateForm({ locale }: { locale: string }) {
	const router = useRouter();
	const [mode, setMode] = useState<Mode>("picker");
	const [submitting, setSubmitting] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	// Picker state
	const [products, setProducts] = useState<ProductRow[]>([]);
	const [loadingProducts, setLoadingProducts] = useState(true);
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);

	// Manual state
	const [mName, setMName] = useState("");
	const [mCategory, setMCategory] = useState("");
	const [mDescription, setMDescription] = useState("");
	const [mListPrice, setMListPrice] = useState("");
	const [mSalePrice, setMSalePrice] = useState("");
	const [mShipping, setMShipping] = useState("");
	const [mGuarantee, setMGuarantee] = useState("");
	const [mBonuses, setMBonuses] = useState("");
	const [mNotes, setMNotes] = useState("");

	useEffect(() => {
		const ctrl = new AbortController();
		fetch("/api/products", { signal: ctrl.signal })
			.then((r) => r.json())
			.then((d) => setProducts(d.products ?? []))
			.catch((e) => {
				if ((e as { name?: string })?.name === "AbortError") return;
				setErr("商品一覧の取得に失敗しました");
			})
			.finally(() => setLoadingProducts(false));
		return () => ctrl.abort();
	}, []);

	const eligible = useMemo(
		() => products.filter((p) => p.status === "completed" || p.status === "extracted"),
		[products],
	);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return eligible;
		return eligible.filter(
			(p) =>
				p.name.toLowerCase().includes(q) ||
				(p.description ?? "").toLowerCase().includes(q) ||
				(p.category ?? "").toLowerCase().includes(q),
		);
	}, [eligible, query]);

	const selectedProduct = useMemo(
		() => products.find((p) => p.id === selectedId) ?? null,
		[products, selectedId],
	);

	const canSubmit = mode === "picker" ? !!selectedId : mName.trim().length > 0 && mDescription.trim().length > 0;

	async function submit() {
		if (!canSubmit) return;
		setSubmitting(true);
		setErr(null);
		try {
			const body: Record<string, unknown> = {};
			if (mode === "picker") {
				body.productId = selectedId;
			} else {
				const bonuses = mBonuses
					.split(/\r?\n/)
					.map((s) => s.trim())
					.filter(Boolean)
					.slice(0, 20);
				const price: Record<string, number> = {};
				const toNum = (s: string) => {
					const n = Number(s.replace(/[, ¥]/g, ""));
					return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN;
				};
				const listN = toNum(mListPrice);
				const saleN = toNum(mSalePrice);
				const shipN = toNum(mShipping);
				if (mListPrice && Number.isFinite(listN)) price.listJpy = listN;
				if (mSalePrice && Number.isFinite(saleN)) price.saleJpy = saleN;
				if (mShipping && Number.isFinite(shipN)) price.shippingJpy = shipN;
				body.productBrief = {
					name: mName.trim(),
					category: mCategory.trim() || undefined,
					description: mDescription.trim(),
					guarantee: mGuarantee.trim() || undefined,
					notes: mNotes.trim() || undefined,
					bonuses: bonuses.length ? bonuses : undefined,
					price: Object.keys(price).length ? price : undefined,
				};
			}
			const res = await fetch("/api/screenplays", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const j = await res.json();
			if (!res.ok) throw new Error(j.error ?? "作成に失敗しました");
			router.push(`/${locale}/screenplays/${j.id}?run=${j.runId}`);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
			setSubmitting(false);
		}
	}

	return (
		<div className="space-y-6">
			{/* Tab switcher */}
			<div className="inline-flex p-1 bg-gray-100 rounded-xl">
				<button
					type="button"
					onClick={() => setMode("picker")}
					className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
						mode === "picker" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
					}`}
				>
					<ListChecks size={14} />
					登録済みの商品から選ぶ
				</button>
				<button
					type="button"
					onClick={() => setMode("manual")}
					className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
						mode === "manual" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
					}`}
				>
					<PencilLine size={14} />
					手入力で作成
				</button>
			</div>

			{mode === "picker" ? (
				<Card className="border-gray-200">
					<CardContent className="p-6">
						<div className="flex items-center justify-between mb-4">
							<div>
								<h2 className="text-base font-semibold text-gray-900">商品を選択</h2>
								<p className="text-xs text-gray-500 mt-0.5">登録済みの商品から、台本を作成したい商品を1つ選んでください。</p>
							</div>
							<span className="text-xs text-gray-400">{filtered.length}件 / 全{eligible.length}件</span>
						</div>

						<div className="relative mb-4">
							<Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
							<input
								type="text"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="商品名・説明・カテゴリで検索"
								className="w-full pl-9 pr-9 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
							/>
							{query && (
								<button
									type="button"
									onClick={() => setQuery("")}
									className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
									aria-label="検索をクリア"
								>
									<X size={14} />
								</button>
							)}
						</div>

						{loadingProducts ? (
							<div className="flex items-center justify-center py-16 gap-2 text-sm text-gray-500">
								<Loader2 size={16} className="animate-spin text-blue-600" />
								商品一覧を読み込み中...
							</div>
						) : filtered.length === 0 ? (
							<div className="flex flex-col items-center justify-center py-16 text-center">
								<div className="w-14 h-14 bg-gray-100 rounded-full flex items-center justify-center mb-3">
									<Package size={24} className="text-gray-400" />
								</div>
								<p className="text-sm text-gray-500">
									{query ? "該当する商品がありません" : "選択可能な商品がありません"}
								</p>
								<p className="text-xs text-gray-400 mt-1">
									「手入力で作成」タブから直接、商品情報を入力することもできます。
								</p>
							</div>
						) : (
							<div className="max-h-[480px] overflow-y-auto -mx-2 px-2 space-y-1.5">
								{filtered.map((p) => {
									const active = p.id === selectedId;
									return (
										<button
											key={p.id}
											type="button"
											onClick={() => setSelectedId(p.id)}
											className={`w-full text-left flex items-start gap-3 p-3 rounded-xl border transition-all ${
												active
													? "border-blue-400 bg-blue-50/40 ring-2 ring-blue-500/20"
													: "border-gray-200 hover:border-blue-200 hover:bg-gray-50"
											}`}
										>
											<div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${active ? "bg-blue-600 text-white" : "bg-blue-50 text-blue-600"}`}>
												{active ? <CheckCircle size={18} /> : <Package size={18} />}
											</div>
											<div className="flex-1 min-w-0">
												<div className="font-medium text-gray-900 truncate">{p.name}</div>
												{p.description && (
													<p className="text-xs text-gray-500 line-clamp-2 mt-0.5">{p.description}</p>
												)}
												<div className="flex items-center gap-2 mt-1.5">
													{p.category && (
														<span className="text-[11px] text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">
															{p.category}
														</span>
													)}
													<span className="text-[11px] text-gray-400">
														{new Date(p.created_at).toLocaleDateString("ja-JP")}
													</span>
												</div>
											</div>
										</button>
									);
								})}
							</div>
						)}
					</CardContent>
				</Card>
			) : (
				<Card className="border-gray-200">
					<CardContent className="p-6 space-y-5">
						<div>
							<h2 className="text-base font-semibold text-gray-900">商品情報を入力</h2>
							<p className="text-xs text-gray-500 mt-0.5">登録されていない商品でも、ここから直接入力して台本を作成できます。</p>
						</div>

						<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
							<div className="md:col-span-2">
								<label className="block text-sm font-medium text-gray-700 mb-1">
									商品名 <span className="text-red-500">*</span>
								</label>
								<input
									type="text"
									value={mName}
									onChange={(e) => setMName(e.target.value)}
									placeholder="例: アイアジャストグラス"
									className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
									maxLength={200}
								/>
							</div>
							<div className="md:col-span-2">
								<label className="block text-sm font-medium text-gray-700 mb-1">カテゴリ</label>
								<input
									type="text"
									value={mCategory}
									onChange={(e) => setMCategory(e.target.value)}
									placeholder="例: ヘルスケア・日用品"
									className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
									maxLength={200}
								/>
							</div>
							<div className="md:col-span-2">
								<label className="block text-sm font-medium text-gray-700 mb-1">
									特徴・スペック <span className="text-red-500">*</span>
								</label>
								<textarea
									value={mDescription}
									onChange={(e) => setMDescription(e.target.value)}
									rows={8}
									placeholder="商品の特徴、対象ユーザー、素材、技術的なポイント、訴求したいベネフィットなど自由に貼り付けてください。"
									className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-y leading-relaxed"
									maxLength={16000}
								/>
								<p className="text-[11px] text-gray-400 mt-1 tabular-nums">{mDescription.length.toLocaleString()} / 16,000 文字</p>
							</div>
							<div>
								<label className="block text-sm font-medium text-gray-700 mb-1">メーカー直販価格 (¥)</label>
								<input
									type="number"
									inputMode="numeric"
									value={mListPrice}
									onChange={(e) => setMListPrice(e.target.value)}
									placeholder="14800"
									min={0}
									className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
								/>
							</div>
							<div>
								<label className="block text-sm font-medium text-gray-700 mb-1">本日特別価格 (¥)</label>
								<input
									type="number"
									inputMode="numeric"
									value={mSalePrice}
									onChange={(e) => setMSalePrice(e.target.value)}
									placeholder="9800"
									min={0}
									className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
								/>
							</div>
							<div>
								<label className="block text-sm font-medium text-gray-700 mb-1">送料 (¥)</label>
								<input
									type="number"
									inputMode="numeric"
									value={mShipping}
									onChange={(e) => setMShipping(e.target.value)}
									placeholder="950"
									min={0}
									className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
								/>
							</div>
							<div>
								<label className="block text-sm font-medium text-gray-700 mb-1">保証</label>
								<input
									type="text"
									value={mGuarantee}
									onChange={(e) => setMGuarantee(e.target.value)}
									placeholder="例: 1年保証"
									className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
									maxLength={500}
								/>
							</div>
							<div className="md:col-span-2">
								<label className="block text-sm font-medium text-gray-700 mb-1">ボーナス・特典 (1行1件)</label>
								<textarea
									value={mBonuses}
									onChange={(e) => setMBonuses(e.target.value)}
									rows={3}
									placeholder={"例:\n専用ケース\nメガネ拭き"}
									className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none"
								/>
							</div>
							<div className="md:col-span-2">
								<label className="block text-sm font-medium text-gray-700 mb-1">その他のメモ</label>
								<textarea
									value={mNotes}
									onChange={(e) => setMNotes(e.target.value)}
									rows={3}
									placeholder="台本に反映したい追加情報があれば自由に記入してください。"
									className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 resize-none"
									maxLength={4000}
								/>
							</div>
						</div>
					</CardContent>
				</Card>
			)}

			{err && (
				<div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
					{err}
				</div>
			)}

			<div className="flex items-center justify-between gap-4 sticky bottom-4 bg-white border border-gray-200 rounded-2xl shadow-sm p-4">
				<div className="min-w-0 flex-1">
					{mode === "picker" ? (
						selectedProduct ? (
							<>
								<div className="text-xs text-gray-500">選択中の商品</div>
								<div className="text-sm font-semibold text-gray-900 truncate mt-0.5">{selectedProduct.name}</div>
							</>
						) : (
							<div className="text-sm text-gray-500">商品を選んでください</div>
						)
					) : mName.trim() ? (
						<>
							<div className="text-xs text-gray-500">入力中の商品</div>
							<div className="text-sm font-semibold text-gray-900 truncate mt-0.5">{mName.trim()}</div>
						</>
					) : (
						<div className="text-sm text-gray-500">商品名と特徴を入力してください</div>
					)}
					<div className="text-[11px] text-gray-400 mt-1">
						生成には約30秒〜2分かかります。完了後にフィードバックで改稿できます。
					</div>
				</div>
				<button
					type="button"
					onClick={submit}
					disabled={!canSubmit || submitting}
					className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-5 py-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
				>
					{submitting ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
					{submitting ? "作成中..." : "台本を生成"}
					{!submitting && <ArrowRight size={14} />}
				</button>
			</div>
		</div>
	);
}
