import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";

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
			"id, version_number, markdown, feedback, base_version_id, model, thinking_level, created_at",
		)
		.eq("screenplay_id", id)
		.order("version_number", { ascending: true });
	if (vErr) {
		console.error("[screenplays] versions fetch failed:", vErr);
		return Response.json({ error: "failed to fetch versions" }, { status: 500 });
	}

	return Response.json({ screenplay, versions: versions ?? [] });
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
