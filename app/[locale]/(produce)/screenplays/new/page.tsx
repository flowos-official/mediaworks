import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ChevronLeft, Clapperboard } from "lucide-react";
import { ScreenplayNewTabs } from "@/components/screenplay/ScreenplayNewTabs";
import type { ExistingProductOption } from "@/components/screenplay/ScreenplayProductPicker";
import { localePath } from "@/lib/i18n/locale-path";
import { getServerClient } from "@/lib/supabase/server";
import { filterMarketRecords } from "@/lib/market/data-visibility";

async function fetchExistingProducts(): Promise<ExistingProductOption[]> {
	const sb = await getServerClient();
	const { data: products, error } = await sb
		.from("products")
		.select("id, name, category, description, status")
		.eq("status", "completed")
		.order("created_at", { ascending: false })
		.limit(40);
	if (error || !products?.length) return [];
	const visibleProducts = filterMarketRecords(products);
	if (visibleProducts.length === 0) return [];

	const ids = visibleProducts.map((product) => product.id as string);
	const { data: researchRows } = await sb
		.from("research_results")
		.select("product_id")
		.in("product_id", ids);
	const researched = new Set((researchRows ?? []).map((row) => row.product_id as string));

	return visibleProducts.map((product) => ({
		id: product.id as string,
		name: product.name as string,
		category: typeof product.category === "string" ? product.category : null,
		description: typeof product.description === "string" ? product.description : null,
		hasResearch: researched.has(product.id as string),
	}));
}

export default async function NewScreenplayPage({ params }: { params: Promise<{ locale: string }> }) {
	const { locale } = await params;
	const [t, products] = await Promise.all([
		getTranslations("screenplay.new"),
		fetchExistingProducts(),
	]);
	return (
		<div className="mx-auto max-w-6xl px-0 py-2 sm:px-2">
			<Link
				href={localePath(locale, "/screenplays")}
				className="mb-5 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronLeft size={14} />
				{t("back")}
			</Link>

			<header className="relative mb-7">
				<div className="flex items-start gap-4">
					<div className="hidden size-11 items-center justify-center rounded-xl border border-blue-500/30 bg-blue-600 text-white shadow-sm sm:flex">
						<Clapperboard size={20} className="text-white" />
					</div>
					<div className="flex-1 min-w-0">
						<div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-blue-600/80">
							Broadcast proof desk
						</div>
						<h2 className="text-2xl font-bold leading-tight tracking-tight text-foreground sm:text-[1.75rem]">
							{t("title")}
						</h2>
						<p className="text-sm text-muted-foreground mt-2 max-w-2xl leading-relaxed">
							{t("subtitle")}
						</p>
					</div>
				</div>
			</header>

			<ScreenplayNewTabs locale={locale} products={products} />
		</div>
	);
}
