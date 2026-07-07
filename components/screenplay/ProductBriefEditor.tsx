"use client";
import { useTranslations } from "next-intl";

export interface BriefDraft {
	name: string;
	category?: string;
	description: string;
	guarantee?: string;
	notes?: string;
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
						/>
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
