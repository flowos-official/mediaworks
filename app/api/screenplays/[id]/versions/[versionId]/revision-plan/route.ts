import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import {
	loadActiveRules,
	loadActiveReferences,
	checkScreenplay,
	callGemini,
} from "@/lib/screenplay/compliance/check";
import { buildRevisionPlan } from "@/lib/screenplay/revision-plan";
import type { ProductBrief } from "@/lib/screenplay/types";
import type { ScriptCheckResult } from "@/lib/screenplay/compliance/types";

export const maxDuration = 90; // may run an on-demand check + plan synthesis (2 serial Gemini calls)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

	// Version must belong to THIS screenplay (RLS is role-only; scope explicitly).
	const { data: ver, error: verErr } = await supabase
		.from("screenplay_versions")
		.select("id, markdown")
		.eq("id", versionId)
		.eq("screenplay_id", id)
		.maybeSingle();
	if (verErr) return Response.json({ error: verErr.message }, { status: 500 });
	if (!ver) return Response.json({ error: "version not found" }, { status: 404 });

	const brief = sp.product_info_snapshot as ProductBrief;
	const markdown = (ver as unknown as { markdown: string }).markdown;

	// Latest persisted check for this version, else run corpus-only on demand
	// (factSearch=false → no Brave egress). The on-demand check is NOT persisted.
	let check: ScriptCheckResult;
	const { data: checkRow } = await supabase
		.from("screenplay_version_checks")
		.select("result")
		.eq("version_id", versionId)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (checkRow?.result) {
		check = checkRow.result as ScriptCheckResult;
	} else {
		const [rules, references] = await Promise.all([loadActiveRules(), loadActiveReferences()]);
		check = await checkScreenplay(markdown, brief, rules, references, { factSearch: false });
	}

	const plan = await buildRevisionPlan(markdown, brief, check, callGemini);
	const findingCount = check.legal.length + check.facts.length + check.quality.length;
	return Response.json({ plan, basedOnScore: check.overallScore, findingCount });
}
