import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MARKDOWN_CHARS = 120_000;

export async function POST(
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
	if (!body || typeof body !== "object") {
		return Response.json({ error: "request body is required" }, { status: 400 });
	}
	const input = body as Record<string, unknown>;
	const markdown = typeof input.markdown === "string" ? input.markdown.trim() : "";
	const baseVersionId = typeof input.baseVersionId === "string" ? input.baseVersionId : "";
	const feedback =
		typeof input.feedback === "string" && input.feedback.trim()
			? input.feedback.trim().slice(0, 500)
			: "本文を直接編集";

	if (markdown.length < 100) {
		return Response.json({ error: "台本本文が短すぎます" }, { status: 400 });
	}
	if (markdown.length > MAX_MARKDOWN_CHARS) {
		return Response.json(
			{ error: `台本本文は ${MAX_MARKDOWN_CHARS.toLocaleString()} 文字以内にしてください` },
			{ status: 400 },
		);
	}
	if (!UUID_RE.test(baseVersionId)) {
		return Response.json({ error: "baseVersionId is required" }, { status: 400 });
	}

	const supabase = getServiceClient();
	const [{ data: screenplay, error: screenplayError }, { data: base, error: baseError }] =
		await Promise.all([
			supabase.from("screenplays").select("id, status").eq("id", id).maybeSingle(),
			supabase
				.from("screenplay_versions")
				.select("id, markdown")
				.eq("id", baseVersionId)
				.eq("screenplay_id", id)
				.maybeSingle(),
		]);
	if (screenplayError || baseError) {
		return Response.json(
			{ error: screenplayError?.message ?? baseError?.message ?? "query failed" },
			{ status: 500 },
		);
	}
	if (!screenplay || !base) {
		return Response.json({ error: "screenplay or base version not found" }, { status: 404 });
	}
	if (screenplay.status === "generating") {
		return Response.json({ error: "別の改稿処理が進行中です" }, { status: 409 });
	}
	if ((base as { markdown: string }).markdown.trim() === markdown) {
		return Response.json({ error: "変更内容がありません" }, { status: 400 });
	}

	let inserted: { id: string; version_number: number } | null = null;
	for (let attempt = 0; attempt < 5; attempt++) {
		const { data: latest } = await supabase
			.from("screenplay_versions")
			.select("version_number")
			.eq("screenplay_id", id)
			.order("version_number", { ascending: false })
			.limit(1);
		const nextVersion = (latest?.[0]?.version_number ?? 0) + 1;
		const { data, error } = await supabase
			.from("screenplay_versions")
			.insert({
				screenplay_id: id,
				version_number: nextVersion,
				markdown,
				feedback,
				base_version_id: baseVersionId,
				model: "manual",
				thinking_level: "none",
			})
			.select("id, version_number")
			.single();
		if (data) {
			inserted = data as { id: string; version_number: number };
			break;
		}
		if ((error as { code?: string } | null)?.code !== "23505") {
			return Response.json({ error: error?.message ?? "version insert failed" }, { status: 500 });
		}
	}
	if (!inserted) {
		return Response.json({ error: "version insert retry exhausted" }, { status: 500 });
	}

	const { error: updateError } = await supabase
		.from("screenplays")
		.update({
			current_version_id: inserted.id,
			status: "ready",
			updated_at: new Date().toISOString(),
		})
		.eq("id", id);
	if (updateError) {
		return Response.json({ error: updateError.message }, { status: 500 });
	}

	return Response.json({
		versionId: inserted.id,
		versionNumber: inserted.version_number,
		needsCheck: true,
	});
}

