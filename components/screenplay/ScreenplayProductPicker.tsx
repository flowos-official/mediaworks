"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
	ArrowRight,
	CheckCircle2,
	Database,
	Loader2,
	PackageSearch,
	Search,
	ShieldCheck,
} from "lucide-react";
import { localePath } from "@/lib/i18n/locale-path";

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

	async function createFromProduct(product: ExistingProductOption) {
		setLoadingId(product.id);
		setError(null);
		try {
			const response = await fetch("/api/screenplays", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ productId: product.id }),
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
								onClick={() => void createFromProduct(product)}
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
			</div>
		</section>
	);
}

