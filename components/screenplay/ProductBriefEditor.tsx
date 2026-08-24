"use client";
import { useTranslations } from "next-intl";
import type { ProductBrief } from "@/lib/screenplay/types";
import { CATEGORIES_BY_CHANNEL } from "@/lib/broadcasts/whitelist-gate";

// Competitor structural patterns (lib/broadcast-intel) only apply when the
// product's category exactly matches one of these — a free-text field
// otherwise fails closed with no visible signal. Surfacing them as
// suggestions (not a hard select) lets an operator pick a matching value
// without losing the field's free-text flexibility.
const CATEGORY_SUGGESTIONS = [...new Set([...CATEGORIES_BY_CHANNEL.qvc, ...CATEGORIES_BY_CHANNEL.shopch])];

export interface BriefDraft {
	name: string;
	category?: string;
	description: string;
	guarantee?: string;
	notes?: string;
	customization?: ProductBrief["customization"];
}

interface Props {
	brief: BriefDraft;
	onBriefChange: (b: BriefDraft) => void;
	bonusesText: string;
	onBonusesChange: (s: string) => void;
	listPrice: string;
	salePrice: string;
	shippingPrice: string;
	onListPrice: (s: string) => void;
	onSalePrice: (s: string) => void;
	onShippingPrice: (s: string) => void;
}

const inputCls =
	"w-full px-3.5 py-2.5 text-sm bg-card border border-border rounded-lg shadow-sm placeholder:text-muted-foreground focus:outline-none focus:ring-4 focus:ring-blue-500/15 focus:border-blue-500 transition-shadow";

export function ProductBriefEditor({
	brief,
	onBriefChange,
	bonusesText,
	onBonusesChange,
	listPrice,
	salePrice,
	shippingPrice,
	onListPrice,
	onSalePrice,
	onShippingPrice,
}: Props) {
	const t = useTranslations("screenplay.form");
	const customization = brief.customization ?? {};
	function updateCustomization(patch: NonNullable<ProductBrief["customization"]>) {
		onBriefChange({
			...brief,
			customization: { ...customization, ...patch },
		});
	}
	return (
		<div className="p-6 space-y-7">
			{/* 基本情報 */}
			<section>
				<div className="flex items-center gap-3 mb-3">
					<h3 className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground">{t("basicInfo")}</h3>
					<div className="h-px flex-1 bg-border" aria-hidden />
				</div>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div className="md:col-span-2">
						<label className="block text-xs font-medium text-foreground mb-1.5">
							{t("productName")} <span className="text-red-500">*</span>
						</label>
						<input
							type="text"
							value={brief.name}
							onChange={(e) => onBriefChange({ ...brief, name: e.target.value })}
							className={inputCls}
							maxLength={200}
						/>
					</div>
					<div className="md:col-span-2">
						<label className="block text-xs font-medium text-foreground mb-1.5">{t("category")}</label>
						<input
							type="text"
							value={brief.category ?? ""}
							onChange={(e) => onBriefChange({ ...brief, category: e.target.value })}
							className={inputCls}
							maxLength={200}
							list="broadcast-category-suggestions"
						/>
						<datalist id="broadcast-category-suggestions">
							{CATEGORY_SUGGESTIONS.map((c) => (
								<option key={c} value={c} />
							))}
						</datalist>
					</div>
					<div className="md:col-span-2">
						<label className="block text-xs font-medium text-foreground mb-1.5">
							{t("description")} <span className="text-red-500">*</span>
						</label>
						<textarea
							value={brief.description}
							onChange={(e) => onBriefChange({ ...brief, description: e.target.value })}
							rows={8}
							className={`${inputCls} resize-y leading-relaxed`}
							maxLength={16000}
						/>
						<div className="flex items-center justify-end mt-1">
							<p className="text-[11px] text-muted-foreground tabular-nums">
								{t("charCount", { count: brief.description.length.toLocaleString() })}
							</p>
						</div>
					</div>
				</div>
			</section>

			<section>
				<div className="mb-3 flex items-center gap-3">
					<h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">制作設計</h3>
					<div className="h-px flex-1 bg-border" aria-hidden />
				</div>
				<p className="mb-4 text-xs leading-relaxed text-muted-foreground">
					自由なプロンプトではなく、変更してよい制作条件を先に固定します。
				</p>
				<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
					<div>
						<label className="mb-1.5 block text-xs font-medium text-foreground">目標放送尺</label>
						<div className="relative">
							<input
								type="number"
								min={1}
								max={120}
								value={customization.runtimeMinutes ?? 25}
								onChange={(event) => updateCustomization({ runtimeMinutes: Number(event.target.value) || 25 })}
								className={`${inputCls} pr-10 tabular-nums`}
							/>
							<span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">分</span>
						</div>
					</div>
					<div>
						<label className="mb-1.5 block text-xs font-medium text-foreground">語り口</label>
						<select
							value={customization.tonalAdjust ?? "neutral"}
							onChange={(event) => updateCustomization({ tonalAdjust: event.target.value as "calm" | "neutral" | "energetic" })}
							className={inputCls}
						>
							<option value="calm">落ち着いた・上品</option>
							<option value="neutral">標準</option>
							<option value="energetic">高エネルギー</option>
						</select>
					</div>
					<div className="md:col-span-2">
						<label className="mb-1.5 block text-xs font-medium text-foreground">ターゲット視聴者</label>
						<input
							type="text"
							value={customization.targetAudience ?? ""}
							onChange={(event) => updateCustomization({ targetAudience: event.target.value })}
							className={inputCls}
							placeholder="例: 睡眠に悩む60代以上。家族用のまとめ買いも検討する方"
						/>
					</div>
					<div className="md:col-span-2">
						<label className="mb-1.5 block text-xs font-medium text-foreground">キー・メッセージ</label>
						<input
							type="text"
							value={customization.keyMessage ?? ""}
							onChange={(event) => updateCustomization({ keyMessage: event.target.value })}
							className={inputCls}
							placeholder="番組を通して繰り返す一つの訴求"
						/>
					</div>
					<div>
						<label className="mb-1.5 block text-xs font-medium text-foreground">必ず入れる実演（1行1件）</label>
						<textarea
							rows={4}
							value={(customization.mustDemos ?? []).join("\n")}
							onChange={(event) => updateCustomization({ mustDemos: event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 12) })}
							className={`${inputCls} resize-none`}
						/>
					</div>
					<div>
						<label className="mb-1.5 block text-xs font-medium text-foreground">言わないこと（1行1件）</label>
						<textarea
							rows={4}
							value={(customization.mustAvoid ?? []).join("\n")}
							onChange={(event) => updateCustomization({ mustAvoid: event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 12) })}
							className={`${inputCls} resize-none`}
						/>
					</div>
				</div>
			</section>

			{/* 価格 */}
			<section>
				<div className="flex items-center gap-3 mb-3">
					<h3 className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground">{t("priceSection")}</h3>
					<div className="h-px flex-1 bg-border" aria-hidden />
				</div>
				<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
					{([
						[t("listPrice"), listPrice, onListPrice],
						[t("salePrice"), salePrice, onSalePrice],
						[t("shipping"), shippingPrice, onShippingPrice],
					] as const).map(([label, val, setter]) => (
						<div key={label}>
							<label className="block text-xs font-medium text-foreground mb-1.5">{label}</label>
							<div className="relative">
								<span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">¥</span>
								<input
									type="number"
									inputMode="numeric"
									value={val}
									onChange={(e) => setter(e.target.value)}
									min={0}
									className={`${inputCls} pl-7 tabular-nums`}
								/>
							</div>
						</div>
					))}
				</div>
			</section>

			{/* 特典・補足 */}
			<section>
				<div className="flex items-center gap-3 mb-3">
					<h3 className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground">{t("bonusSection")}</h3>
					<div className="h-px flex-1 bg-border" aria-hidden />
				</div>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div>
						<label className="block text-xs font-medium text-foreground mb-1.5">{t("guarantee")}</label>
						<input
							type="text"
							value={brief.guarantee ?? ""}
							onChange={(e) => onBriefChange({ ...brief, guarantee: e.target.value })}
							className={inputCls}
							maxLength={500}
						/>
					</div>
					<div>
						<label className="block text-xs font-medium text-foreground mb-1.5">{t("bonuses")}</label>
						<textarea
							value={bonusesText}
							onChange={(e) => onBonusesChange(e.target.value)}
							rows={3}
							className={`${inputCls} resize-none`}
						/>
					</div>
					<div className="md:col-span-2">
						<label className="block text-xs font-medium text-foreground mb-1.5">{t("notes")}</label>
						<textarea
							value={brief.notes ?? ""}
							onChange={(e) => onBriefChange({ ...brief, notes: e.target.value })}
							rows={3}
							className={`${inputCls} resize-none`}
							maxLength={4000}
						/>
					</div>
				</div>
			</section>
		</div>
	);
}
