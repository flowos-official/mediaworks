import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { loadActiveRules, loadActiveReferences, checkScreenplay } from "@/lib/screenplay/compliance/check";
import type { ProductBrief } from "@/lib/screenplay/types";

export const maxDuration = 90;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Loads the version row only if it belongs to the screenplay (tenant scope).
async function loadOwnedVersion(
	supabase: ReturnType<typeof getServiceClient>,
	id: string,
	versionId: string,
	columns: string,
) {
	const { data, error } = await supabase
		.from("screenplay_versions")
		.select(columns)
		.eq("id", versionId)
		.eq("screenplay_id", id)
		.maybeSingle();
	return { data, error };
}

// GET: latest check for THIS version. 200 {check:null} when none; 404 when the
// version is not found / not owned by this screenplay; 500 on query failure.
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string; versionId: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id, versionId } = await params;
	if (!UUID_RE.test(id) || !UUID_RE.test(versionId)) {
		return Response.json({ error: "invalid id" }, { status: 404 });
	}

	const supabase = getServiceClient();
	const { data: ver, error: verErr } = await loadOwnedVersion(supabase, id, versionId, "id");
	if (verErr) return Response.json({ error: verErr.message }, { status: 500 });
	if (!ver) return Response.json({ error: "version not found" }, { status: 404 });

	const { data, error } = await supabase
		.from("screenplay_version_checks")
		.select("id, overall_score, result, created_at, is_auto, lexicon_version")
		.eq("version_id", versionId)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (error) return Response.json({ error: error.message }, { status: 500 });
	if (!data) return Response.json({ check: null });

	return Response.json({
		check: {
			id: data.id,
			created_at: data.created_at,
			is_auto: data.is_auto,
			lexicon_version: data.lexicon_version ?? undefined,
			...(data.result as object),
		},
	});
}

// POST: re-check THIS version on demand.
export async function POST(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string; versionId: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id, versionId } = await params;
	if (!UUID_RE.test(id) || !UUID_RE.test(versionId)) {
		return Response.json({ error: "invalid id" }, { status: 404 });
	}

	const supabase = getServiceClient();
	const { data: sp, error: spErr } = await supabase
		.from("screenplays")
		.select("id, product_info_snapshot")
		.eq("id", id)
		.maybeSingle();
	if (spErr) return Response.json({ error: spErr.message }, { status: 500 });
	if (!sp) return Response.json({ error: "screenplay not found" }, { status: 404 });

	const { data: ver, error: verErr } = await loadOwnedVersion(supabase, id, versionId, "id, markdown");
	if (verErr) return Response.json({ error: verErr.message }, { status: 500 });
	if (!ver) return Response.json({ error: "version not found" }, { status: 404 });

	const [rules, references] = await Promise.all([loadActiveRules(), loadActiveReferences()]);
	const result = await checkScreenplay(
		(ver as unknown as { markdown: string }).markdown,
		sp.product_info_snapshot as ProductBrief,
		rules,
		references,
		{ factSearch: true },
	);

	const lexiconVersion = `rules:${rules.length} refs:${references.length} h:${result.grounding?.corpusHash ?? ""}`;
	const { data: inserted, error: insErr } = await supabase
		.from("screenplay_version_checks")
		.insert({
			version_id: versionId,
			overall_score: result.overallScore,
			result,
			lexicon_version: lexiconVersion,
			is_auto: false,
			created_by: auth.user.id,
		})
		.select("id, created_at")
		.single();
	if (insErr) return Response.json({ error: insErr.message }, { status: 500 });

	return Response.json({
		check: { id: inserted.id, created_at: inserted.created_at, is_auto: false, lexicon_version: lexiconVersion, ...result },
	});
}
