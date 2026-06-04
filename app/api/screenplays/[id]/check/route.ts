import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { loadActiveRules, loadActiveReferences, checkScreenplay } from "@/lib/screenplay/compliance/check";
import type { ProductBrief } from "@/lib/screenplay/types";

export const maxDuration = 90;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET: latest check for the screenplay's current version (null if none yet).
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await params;
	if (!UUID_RE.test(id)) return Response.json({ error: "invalid id" }, { status: 404 });

	const supabase = getServiceClient();
	const { data: sp, error: spErr } = await supabase
		.from("screenplays")
		.select("current_version_id")
		.eq("id", id)
		.single();
	if (spErr || !sp || !sp.current_version_id) {
		return Response.json({ check: null });
	}

	const { data } = await supabase
		.from("screenplay_version_checks")
		.select("id, overall_score, result, created_at, is_auto")
		.eq("version_id", sp.current_version_id)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();

	if (!data) return Response.json({ check: null });
	return Response.json({
		check: {
			id: data.id,
			created_at: data.created_at,
			is_auto: data.is_auto,
			...(data.result as object),
		},
	});
}

// POST: re-check the screenplay's current version on demand.
export async function POST(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await params;
	if (!UUID_RE.test(id)) return Response.json({ error: "invalid id" }, { status: 404 });

	const supabase = getServiceClient();
	const { data: sp, error: spErr } = await supabase
		.from("screenplays")
		.select("id, product_info_snapshot, current_version_id")
		.eq("id", id)
		.single();
	if (spErr || !sp || !sp.current_version_id) {
		return Response.json({ error: "screenplay or current version not found" }, { status: 404 });
	}

	const { data: ver, error: verErr } = await supabase
		.from("screenplay_versions")
		.select("id, markdown")
		.eq("id", sp.current_version_id)
		.single();
	if (verErr || !ver) return Response.json({ error: "version not found" }, { status: 404 });

	const [rules, references] = await Promise.all([loadActiveRules(), loadActiveReferences()]);
	// Manual re-check = full grounding incl. live fact search.
	const result = await checkScreenplay(ver.markdown as string, sp.product_info_snapshot as ProductBrief, rules, references, { factSearch: true });

	const { data: inserted, error: insErr } = await supabase
		.from("screenplay_version_checks")
		.insert({
			version_id: ver.id,
			overall_score: result.overallScore,
			result,
			lexicon_version: `rules:${rules.length} refs:${references.length} h:${result.grounding?.corpusHash ?? ""}`,
			is_auto: false,
			created_by: auth.user.id,
		})
		.select("id, created_at")
		.single();
	if (insErr) return Response.json({ error: insErr.message }, { status: 500 });

	return Response.json({ check: { id: inserted.id, created_at: inserted.created_at, ...result } });
}
