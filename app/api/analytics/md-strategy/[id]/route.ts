import { requireUser } from "@/lib/auth/require-user";
import { NextRequest } from "next/server";
import { getServiceClient } from "@/lib/supabase";

// GET: Fetch a single strategy with full skill results
export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	// auth: requireUser
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { id } = await params;
	const supabase = getServiceClient();

	const { data, error } = await supabase
		.from("md_strategies")
		.select("*")
		.eq("id", id)
		.single();

	if (error || !data) {
		return Response.json({ error: error?.message ?? "Not found" }, { status: 404 });
	}
	return Response.json(data);
}

// DELETE: Remove a strategy
export async function DELETE(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	// auth: requireUser
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { id } = await params;
	const supabase = getServiceClient();

	const { error } = await supabase
		.from("md_strategies")
		.delete()
		.eq("id", id);

	if (error) {
		return Response.json({ error: error.message }, { status: 500 });
	}
	return Response.json({ ok: true });
}
