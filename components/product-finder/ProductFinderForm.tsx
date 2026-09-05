"use client";

/**
 * The query form.
 *
 * The submit copy names what the search actually does — "search with stored
 * data" — because the single most likely misreading of this screen is that it
 * went and looked something up.
 *
 * Every field is optional. An empty form is a legitimate question ("what does
 * our evidence favour right now"), and requiring a category would push
 * operators into inventing one.
 */
import { useState } from "react";
import { useTranslations } from "next-intl";

export interface ProductFinderFormValues {
	category?: string;
	targetCustomer?: string;
	priceMinJpy?: number;
	priceMaxJpy?: number;
	targetMarginRate?: number;
	desiredFeatures: string[];
	excludedTerms: string[];
	limit: number;
	mode: "stored_only";
}

/** Blank stays blank. Number("") is 0, which would silently become a real
 *  filter the operator never typed. */
function optionalNumber(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function list(raw: string): string[] {
	return raw
		.split(",")
		.map((v) => v.trim())
		.filter((v) => v.length > 0);
}

export function ProductFinderForm({
	onSubmit,
	pending,
}: {
	onSubmit: (values: ProductFinderFormValues) => void;
	pending: boolean;
}) {
	const t = useTranslations("productFinder");
	const [category, setCategory] = useState("");
	const [targetCustomer, setTargetCustomer] = useState("");
	const [priceMin, setPriceMin] = useState("");
	const [priceMax, setPriceMax] = useState("");
	const [margin, setMargin] = useState("");
	const [features, setFeatures] = useState("");
	const [excluded, setExcluded] = useState("");
	const [limit, setLimit] = useState(10);

	return (
		<form
			className="space-y-3 rounded-lg border bg-card p-4"
			onSubmit={(e) => {
				e.preventDefault();
				onSubmit({
					category: category.trim() || undefined,
					targetCustomer: targetCustomer.trim() || undefined,
					priceMinJpy: optionalNumber(priceMin),
					priceMaxJpy: optionalNumber(priceMax),
					targetMarginRate: optionalNumber(margin),
					desiredFeatures: list(features),
					excludedTerms: list(excluded),
					limit,
					mode: "stored_only",
				});
			}}
		>
			<div className="grid gap-3 sm:grid-cols-2">
				<label className="space-y-1 text-sm">
					<span className="text-muted-foreground">{t("form.category")}</span>
					<input
						className="w-full rounded border bg-background px-2 py-1"
						value={category}
						onChange={(e) => setCategory(e.target.value)}
						placeholder={t("form.categoryPlaceholder")}
					/>
				</label>
				<label className="space-y-1 text-sm">
					<span className="text-muted-foreground">{t("form.targetCustomer")}</span>
					<input
						className="w-full rounded border bg-background px-2 py-1"
						value={targetCustomer}
						onChange={(e) => setTargetCustomer(e.target.value)}
						placeholder={t("form.targetCustomerPlaceholder")}
					/>
				</label>
				<label className="space-y-1 text-sm">
					<span className="text-muted-foreground">{t("form.priceMin")}</span>
					<input
						type="number"
						min={0}
						className="w-full rounded border bg-background px-2 py-1"
						value={priceMin}
						onChange={(e) => setPriceMin(e.target.value)}
					/>
				</label>
				<label className="space-y-1 text-sm">
					<span className="text-muted-foreground">{t("form.priceMax")}</span>
					<input
						type="number"
						min={0}
						className="w-full rounded border bg-background px-2 py-1"
						value={priceMax}
						onChange={(e) => setPriceMax(e.target.value)}
					/>
				</label>
				<label className="space-y-1 text-sm">
					<span className="text-muted-foreground">{t("form.targetMargin")}</span>
					<input
						type="number"
						min={0}
						max={100}
						className="w-full rounded border bg-background px-2 py-1"
						value={margin}
						onChange={(e) => setMargin(e.target.value)}
					/>
				</label>
				<label className="space-y-1 text-sm">
					<span className="text-muted-foreground">{t("form.limit")}</span>
					<input
						type="number"
						min={5}
						max={30}
						className="w-full rounded border bg-background px-2 py-1"
						value={limit}
						onChange={(e) => setLimit(Number.parseInt(e.target.value, 10) || 10)}
					/>
				</label>
				<label className="space-y-1 text-sm sm:col-span-2">
					<span className="text-muted-foreground">{t("form.desiredFeatures")}</span>
					<input
						className="w-full rounded border bg-background px-2 py-1"
						value={features}
						onChange={(e) => setFeatures(e.target.value)}
						placeholder={t("form.desiredFeaturesPlaceholder")}
					/>
				</label>
				<label className="space-y-1 text-sm sm:col-span-2">
					<span className="text-muted-foreground">{t("form.excludedTerms")}</span>
					<input
						className="w-full rounded border bg-background px-2 py-1"
						value={excluded}
						onChange={(e) => setExcluded(e.target.value)}
						placeholder={t("form.excludedTermsPlaceholder")}
					/>
				</label>
			</div>

			<button
				type="submit"
				disabled={pending}
				className="rounded bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50"
			>
				{pending ? t("form.submitting") : t("form.submit")}
			</button>
		</form>
	);
}
