import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ScreenplayWorkspace } from "@/components/screenplay/ScreenplayWorkspace";
import type { ScreenplayRow, ScreenplayVersionRow } from "@/lib/screenplay/types";
import type { ScriptCheckResult } from "@/lib/screenplay/compliance/types";
import { localePath } from "@/lib/i18n/locale-path";
import { getServerClient } from "@/lib/supabase/server";
import type { ExistingProductOption } from "@/components/screenplay/ScreenplayProductPicker";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Direct Supabase query — same rationale as screenplays/page.tsx:
// the previous fetch to /api/screenplays/[id] hit the prod URL in dev and
// could not forward auth cookies from a server component.
async function fetchDetail(id: string) {
	if (!UUID_RE.test(id)) return null;
	const sb = await getServerClient();

	const { data: screenplay, error: spErr } = await sb
		.from("screenplays")
		.select("*")
		.eq("id", id)
		.maybeSingle();
	if (spErr || !screenplay) return null;

	const { data: versions } = await sb
		.from("screenplay_versions")
		.select(
			"id, version_number, markdown, feedback, base_version_id, model, thinking_level, pattern_snapshot, created_at",
		)
		.eq("screenplay_id", id)
		.order("version_number", { ascending: true });

	let latestCheck: (ScriptCheckResult & { created_at?: string; lexicon_version?: string }) | null = null;
	if (screenplay.current_version_id) {
		const { data } = await sb
			.from("screenplay_version_checks")
			.select("overall_score, result, created_at, lexicon_version, is_auto")
			.eq("version_id", screenplay.current_version_id)
			.order("created_at", { ascending: false })
			.limit(1)
			.maybeSingle();
		if (data) latestCheck = { ...(data.result as object), created_at: data.created_at, lexicon_version: data.lexicon_version ?? undefined, is_auto: data.is_auto } as ScriptCheckResult & { created_at?: string; lexicon_version?: string; is_auto?: boolean };
	}

	return {
		screenplay: screenplay as ScreenplayRow,
		versions: (versions ?? []) as ScreenplayVersionRow[],
		latestCheck,
	};
}

async function fetchAvailableProducts(): Promise<ExistingProductOption[]> {
	const sb = await getServerClient();
	const { data: products } = await sb
		.from("products")
		.select("id, name, category, description, status")
		.eq("status", "completed")
		.order("created_at", { ascending: false })
		.limit(40);
	if (!products?.length) return [];
	const ids = products.map((product) => product.id as string);
	const { data: researchRows } = await sb
		.from("research_results")
		.select("product_id")
		.in("product_id", ids);
	const researched = new Set((researchRows ?? []).map((row) => row.product_id as string));
	return products.map((product) => ({
		id: product.id as string,
		name: product.name as string,
		category: typeof product.category === "string" ? product.category : null,
		description: typeof product.description === "string" ? product.description : null,
		hasResearch: researched.has(product.id as string),
	}));
}

export default async function ScreenplayDetailPage({ params }: { params: Promise<{ id: string; locale: string }> }) {
	const { id, locale } = await params;
	const [data, t, availableProducts] = await Promise.all([
		fetchDetail(id),
		getTranslations("screenplay"),
		fetchAvailableProducts(),
	]);
	if (!data) notFound();
	const { screenplay, versions, latestCheck } = data;

	return (
		<>
			<Link
				href={localePath(locale, "/screenplays")}
				className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
			>
				<ChevronLeft size={14} />
				{t("detail.back")}
			</Link>
			<ScreenplayWorkspace
				initialScreenplay={screenplay}
				initialVersions={versions}
				latestCheck={latestCheck}
				initialCheckVersionId={screenplay.current_version_id ?? null}
				availableProducts={availableProducts}
			/>
		</>
	);
}
