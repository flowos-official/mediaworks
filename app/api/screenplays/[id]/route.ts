import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { loadProductBriefForScreenplay } from "@/lib/screenplay/product-brief";
import { rowToContext } from "@/lib/screenplay/context/build";
import type { ProductBrief, ScreenplayClaimLinkRow } from "@/lib/screenplay/types";

export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await params;
	if (!UUID_RE.test(id)) {
		return Response.json({ error: "invalid id" }, { status: 404 });
	}
	const supabase = getServiceClient();

	const { data: screenplay, error: spErr } = await supabase
		.from("screenplays")
		.select("*")
		.eq("id", id)
		.single();
	if (spErr || !screenplay) {
		return Response.json({ error: "not found" }, { status: 404 });
	}

	const { data: versions, error: vErr } = await supabase
		.from("screenplay_versions")
		.select(
			"id, version_number, markdown, feedback, base_version_id, model, thinking_level, created_at, pattern_snapshot, generation_context_id",
		)
		.eq("screenplay_id", id)
		.order("version_number", { ascending: true });
	if (vErr) {
		console.error("[screenplays] versions fetch failed:", vErr);
		return Response.json({ error: "failed to fetch versions" }, { status: 500 });
	}

	const versionRows = versions ?? [];
	const versionIds = versionRows.map((v) => String(v.id));

	// Contexts are scoped by screenplay_id and claim links by version_id, not
	// by the ids the caller happens to hold: a version's provenance must be
	// unreachable from another screenplay's request even if an id leaks.
	const [contexts, claimLinks] = await Promise.all([
		supabase.from("screenplay_generation_contexts").select("*").eq("screenplay_id", id),
		versionIds.length > 0
			? supabase
					.from("screenplay_claim_links")
					.select("id, version_id, line_start, line_end, claim_text, status, evidence_item_id, reason")
					.in("version_id", versionIds)
					.order("line_start", { ascending: true })
			: Promise.resolve({ data: [], error: null }),
	]);
	// Provenance is supplementary: a version still renders without it, and a
	// failure here must not take the script down with it.
	if (contexts.error) console.warn("[screenplays] context fetch failed:", contexts.error.message);
	if (claimLinks.error) console.warn("[screenplays] claim link fetch failed:", claimLinks.error.message);

	const contextById = new Map(
		(contexts.data ?? []).map((row) => [String(row.id), rowToContext(row as Record<string, unknown>)]),
	);
	const linksByVersion = new Map<string, ScreenplayClaimLinkRow[]>();
	for (const row of (claimLinks.data ?? []) as ScreenplayClaimLinkRow[]) {
		const held = linksByVersion.get(row.version_id);
		if (held) held.push(row);
		else linksByVersion.set(row.version_id, [row]);
	}

	return Response.json({
		screenplay,
		versions: versionRows.map((version) => ({
			...version,
			// Null, not an empty object: a legacy version genuinely has no
			// context, and the UI has to be able to say so.
			generation_context: version.generation_context_id
				? contextById.get(String(version.generation_context_id)) ?? null
				: null,
			claim_links: linksByVersion.get(String(version.id)) ?? [],
		})),
	});
}

export async function DELETE(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await params;
	if (!UUID_RE.test(id)) {
		// Idempotent: deleting an invalid id is a no-op success.
		return Response.json({ ok: true });
	}
	const supabase = getServiceClient();
	const { error } = await supabase.from("screenplays").delete().eq("id", id);
	if (error) {
		console.error("[screenplays] delete failed:", error);
		return Response.json({ error: "failed to delete" }, { status: 500 });
	}
	return Response.json({ ok: true });
}

export async function PATCH(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await params;
	if (!UUID_RE.test(id)) {
		return Response.json({ error: "invalid id" }, { status: 404 });
	}
	const body = await request.json().catch(() => null);
	const productId =
		body && typeof body === "object" && typeof (body as Record<string, unknown>).productId === "string"
			? ((body as Record<string, unknown>).productId as string).trim()
			: "";
	if (!UUID_RE.test(productId)) {
		return Response.json({ error: "productId is required" }, { status: 400 });
	}

	const supabase = getServiceClient();
	const [{ data: screenplay, error: screenplayError }, loaded] = await Promise.all([
		supabase
			.from("screenplays")
			.select("id, product_info_snapshot")
			.eq("id", id)
			.maybeSingle(),
		loadProductBriefForScreenplay(supabase, productId),
	]);
	if (screenplayError) {
		return Response.json({ error: screenplayError.message }, { status: 500 });
	}
	if (!screenplay) {
		return Response.json({ error: "screenplay not found" }, { status: 404 });
	}
	if (!loaded.ok) {
		return Response.json({ error: loaded.error }, { status: loaded.status });
	}

	const current = (screenplay.product_info_snapshot ?? {}) as ProductBrief;
	const brief: ProductBrief = {
		...loaded.brief,
		price: current.price ?? loaded.brief.price,
		bonuses: current.bonuses?.length ? current.bonuses : loaded.brief.bonuses,
		guarantee: current.guarantee ?? loaded.brief.guarantee,
		customization: current.customization,
	};
	if (current.notes && loaded.brief.notes && current.notes !== loaded.brief.notes) {
		brief.notes = `${loaded.brief.notes}\n\n既存台本から引き継いだメモ:\n${current.notes}`.slice(0, 4000);
	} else {
		brief.notes = current.notes ?? loaded.brief.notes;
	}

	const { error: updateError } = await supabase
		.from("screenplays")
		.update({
			product_id: productId,
			product_info_snapshot: brief,
			updated_at: new Date().toISOString(),
		})
		.eq("id", id);
	if (updateError) {
		return Response.json({ error: updateError.message }, { status: 500 });
	}
	return Response.json({ productId, brief });
}
