"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
	ArrowLeft,
	ArrowRight,
	CheckCircle2,
	Database,
	Loader2,
	PackageSearch,
	Search,
	ShieldCheck,
	SlidersHorizontal,
	Sparkles,
} from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";
import type { ProductBrief } from "@/lib/screenplay/types";

export interface ExistingProductOption {
	id: string;
	name: string;
	category: string | null;
	description: string | null;
	hasResearch: boolean;
}

interface Props {
	locale: string;
	products: ExistingProductOption[];
}

export function ScreenplayProductPicker({ locale, products }: Props) {
	const t = useTranslations("screenplay.productPicker");
	const router = useRouter();
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<ExistingProductOption | null>(null);
	const [customization, setCustomization] = useState<
		NonNullable<ProductBrief["customization"]>
	>({ runtimeMinutes: 25, tonalAdjust: "neutral" });
	const [listPrice, setListPrice] = useState("");
	const [salePrice, setSalePrice] = useState("");
	const [shippingPrice, setShippingPrice] = useState("");
	const [guarantee, setGuarantee] = useState("");
	const [bonuses, setBonuses] = useState("");
	const [loadingId, setLoadingId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const filtered = useMemo(() => {
		const q = query.trim().toLocaleLowerCase();
		if (!q) return products;
		return products.filter((product) =>
			[product.name, product.category ?? "", product.description ?? ""]
				.join(" ")
				.toLocaleLowerCase()
				.includes(q),
		);
	}, [products, query]);

	function updateCustomization(patch: NonNullable<ProductBrief["customization"]>) {
		setCustomization((current) => ({ ...current, ...patch }));
	}

	function lines(value: string): string[] {
		return value
			.split(/\r?\n/)
			.map((item) => item.trim())
			.filter(Boolean)
			.slice(0, 12);
	}

	function amount(value: string): number | undefined {
		const normalized = value.replace(/[, ¥円\s]/g, "");
		if (!normalized) return undefined;
		const number = Number(normalized);
		return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
	}

	async function createFromProduct(product: ExistingProductOption) {
		setLoadingId(product.id);
		setError(null);
		try {
			const response = await fetch("/api/screenplays", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					productId: product.id,
					customization,
					offer: {
						price: {
							listJpy: amount(listPrice),
							saleJpy: amount(salePrice),
							shippingJpy: amount(shippingPrice),
						},
						guarantee,
						bonuses: lines(bonuses),
					},
				}),
			});
			const payload = (await response.json()) as {
				id?: string;
				runId?: string;
				error?: string;
			};
			if (!response.ok || !payload.id || !payload.runId) {
				throw new Error(payload.error ?? t("createFailed"));
			}
			router.push(
				localePath(locale, `/screenplays/${payload.id}?run=${payload.runId}`),
			);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("createFailed"));
			setLoadingId(null);
		}
	}

	const canCreate = Boolean(
		selected &&
			customization.targetAudience?.trim() &&
			customization.keyMessage?.trim() &&
			amount(salePrice) !== undefined,
	);
	const inputClass =
		"w-full rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15";

	return (
		<section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
			<div className="border-b border-border bg-[linear-gradient(135deg,rgba(37,99,235,0.12),transparent_58%)] px-5 py-5 sm:px-6">
				<div className="flex items-start gap-3">
					<div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
						<Database size={18} />
					</div>
					<div>
						<div className="mb-1 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-blue-600">
							<CheckCircle2 size={11} /> {t("recommended")}
						</div>
						<h2 className="text-base font-semibold text-foreground">{t("heading")}</h2>
						<p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
							{t("description")}
						</p>
					</div>
				</div>
			</div>

			<div className="p-5 sm:p-6">
				{selected ? (
					<div className="space-y-6">
						<button
							type="button"
							onClick={() => {
								setSelected(null);
								setError(null);
							}}
							className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-foreground"
						>
							<ArrowLeft size={13} />
							{t("backToProducts")}
						</button>

						<div className="rounded-xl border border-blue-500/30 bg-blue-600/[0.06] p-4">
							<div className="flex items-start gap-3">
								<div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-600 text-white">
									<PackageSearch size={17} />
								</div>
								<div className="min-w-0">
									<div className="text-sm font-semibold text-foreground">{selected.name}</div>
									<div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
										{selected.category && <span className="rounded bg-muted px-1.5 py-0.5">{selected.category}</span>}
										<span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
											<ShieldCheck size={11} />
											{selected.hasResearch ? t("researchReady") : t("productFactsReady")}
										</span>
									</div>
								</div>
							</div>
						</div>

						<div>
							<div className="mb-1 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-blue-600">
								<SlidersHorizontal size={11} /> {t("designBadge")}
							</div>
							<h3 className="text-base font-semibold text-foreground">{t("designHeading")}</h3>
							<p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("designDescription")}</p>
						</div>

						<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
							<div>
								<label className="mb-1.5 block text-xs font-medium text-foreground">{t("runtime")}</label>
								<div className="relative">
									<input
										type="number"
										min={1}
										max={120}
										value={customization.runtimeMinutes ?? 25}
										onChange={(event) => updateCustomization({ runtimeMinutes: Number(event.target.value) || 25 })}
										className={`${inputClass} pr-10 tabular-nums`}
									/>
									<span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{t("minutes")}</span>
								</div>
							</div>
							<div>
								<label className="mb-1.5 block text-xs font-medium text-foreground">{t("tone")}</label>
								<select
									value={customization.tonalAdjust ?? "neutral"}
									onChange={(event) => updateCustomization({ tonalAdjust: event.target.value as "calm" | "neutral" | "energetic" })}
									className={inputClass}
								>
									<option value="calm">{t("toneCalm")}</option>
									<option value="neutral">{t("toneNeutral")}</option>
									<option value="energetic">{t("toneEnergetic")}</option>
								</select>
							</div>
							<div className="md:col-span-2">
								<label className="mb-1.5 block text-xs font-medium text-foreground">
									{t("targetAudience")} <span className="text-red-500">*</span>
								</label>
								<input
									type="text"
									value={customization.targetAudience ?? ""}
									onChange={(event) => updateCustomization({ targetAudience: event.target.value })}
									placeholder={t("targetAudiencePlaceholder")}
									maxLength={600}
									className={inputClass}
								/>
							</div>
							<div className="md:col-span-2">
								<label className="mb-1.5 block text-xs font-medium text-foreground">
									{t("keyMessage")} <span className="text-red-500">*</span>
								</label>
								<input
									type="text"
									value={customization.keyMessage ?? ""}
									onChange={(event) => updateCustomization({ keyMessage: event.target.value })}
									placeholder={t("keyMessagePlaceholder")}
									maxLength={300}
									className={inputClass}
								/>
							</div>
							<div className="md:col-span-2 border-t border-border pt-4">
								<h4 className="text-xs font-semibold text-foreground">{t("offerHeading")}</h4>
								<p className="mt-1 text-[11px] text-muted-foreground">{t("offerDescription")}</p>
							</div>
							{([
								[t("listPrice"), listPrice, setListPrice, false],
								[t("salePrice"), salePrice, setSalePrice, true],
								[t("shippingPrice"), shippingPrice, setShippingPrice, false],
							] as const).map(([label, value, setter, required]) => (
								<div key={label}>
									<label className="mb-1.5 block text-xs font-medium text-foreground">
										{label} {required && <span className="text-red-500">*</span>}
									</label>
									<div className="relative">
										<span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">¥</span>
										<input
											type="number"
											inputMode="numeric"
											min={0}
											value={value}
											onChange={(event) => setter(event.target.value)}
											className={`${inputClass} pl-7 tabular-nums`}
										/>
									</div>
								</div>
							))}
							<div className="md:col-span-2">
								<label className="mb-1.5 block text-xs font-medium text-foreground">{t("guarantee")}</label>
								<input
									type="text"
									value={guarantee}
									onChange={(event) => setGuarantee(event.target.value)}
									maxLength={500}
									className={inputClass}
								/>
							</div>
							<div className="md:col-span-2">
								<label className="mb-1.5 block text-xs font-medium text-foreground">{t("bonuses")}</label>
								<textarea
									rows={3}
									value={bonuses}
									onChange={(event) => setBonuses(event.target.value)}
									placeholder={t("lineHint")}
									className={`${inputClass} resize-none`}
								/>
							</div>
							<div>
								<label className="mb-1.5 block text-xs font-medium text-foreground">{t("mustDemos")}</label>
								<textarea
									rows={4}
									value={(customization.mustDemos ?? []).join("\n")}
									onChange={(event) => updateCustomization({ mustDemos: lines(event.target.value) })}
									placeholder={t("lineHint")}
									className={`${inputClass} resize-none`}
								/>
							</div>
							<div>
								<label className="mb-1.5 block text-xs font-medium text-foreground">{t("mustAvoid")}</label>
								<textarea
									rows={4}
									value={(customization.mustAvoid ?? []).join("\n")}
									onChange={(event) => updateCustomization({ mustAvoid: lines(event.target.value) })}
									placeholder={t("lineHint")}
									className={`${inputClass} resize-none`}
								/>
							</div>
						</div>

						{error && (
							<p className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">{error}</p>
						)}
						<div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
							<p className="text-[11px] text-muted-foreground">{t("requiredHint")}</p>
							<button
								type="button"
								onClick={() => void createFromProduct(selected)}
								disabled={!canCreate || loadingId != null}
								className="inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 px-5 py-3 text-sm font-medium text-white shadow-sm transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
							>
								{loadingId ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
								{loadingId ? t("generating") : t("generate")}
								{!loadingId && <ArrowRight size={14} className="opacity-70" />}
							</button>
						</div>
					</div>
				) : (
					<>
				<label className="relative block">
					<span className="sr-only">{t("searchLabel")}</span>
					<Search
						size={16}
						className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
					/>
					<input
						type="search"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder={t("searchPlaceholder")}
						className="h-11 w-full rounded-xl border border-border bg-background pl-10 pr-4 text-sm text-foreground outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15"
					/>
				</label>

				{error && (
					<p className="mt-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
						{error}
					</p>
				)}

				<div className="mt-4 max-h-[34rem] space-y-2 overflow-y-auto pr-1">
					{filtered.map((product) => {
						const loading = loadingId === product.id;
						return (
							<button
								key={product.id}
								type="button"
								onClick={() => {
									setSelected(product);
									setError(null);
								}}
								disabled={loadingId != null}
								className="group grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 rounded-xl border border-border bg-background px-4 py-3 text-left transition hover:border-blue-500/60 hover:bg-blue-600/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60"
							>
								<div className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground group-hover:text-blue-600">
									<PackageSearch size={17} />
								</div>
								<div className="min-w-0">
									<div className="truncate text-sm font-semibold text-foreground">
										{product.name}
									</div>
									<div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
										{product.category && (
											<span className="rounded bg-muted px-1.5 py-0.5">{product.category}</span>
										)}
											<span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
												<ShieldCheck size={11} />
												{product.hasResearch ? t("researchReady") : t("productFactsReady")}
											</span>
										</div>
									</div>
									{loading ? (
									<Loader2 size={16} className="animate-spin text-blue-600" />
								) : (
									<ArrowRight size={15} className="text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-blue-600" />
								)}
							</button>
						);
					})}
					{filtered.length === 0 && (
						<div className="rounded-xl border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground">
							{t("empty")}
						</div>
							)}
						</div>
						</>
					)}
				</div>
		</section>
	);
}
