import { NextRequest } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 30;

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const supabase = getServiceClient();

	const { data: screenplay, error: spErr } = await supabase
		.from("screenplays")
		.select("*")
		.eq("id", id)
		.single();
	if (spErr || !screenplay) {
		return Response.json(
			{ error: spErr?.message ?? "Not found" },
			{ status: 404 },
		);
	}

	const { data: versions, error: vErr } = await supabase
		.from("screenplay_versions")
		.select(
			"id, version_number, markdown, feedback, base_version_id, model, thinking_level, created_at",
		)
		.eq("screenplay_id", id)
		.order("version_number", { ascending: true });
	if (vErr) {
		return Response.json({ error: vErr.message }, { status: 500 });
	}

	return Response.json({ screenplay, versions: versions ?? [] });
}

export async function DELETE(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const { id } = await params;
	const supabase = getServiceClient();
	const { error } = await supabase.from("screenplays").delete().eq("id", id);
	if (error) return Response.json({ error: error.message }, { status: 500 });
	return Response.json({ ok: true });
}
