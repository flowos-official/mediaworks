import { requireUser } from "@/lib/auth/require-user";
import { NextResponse, type NextRequest } from "next/server";

export async function POST(
	req: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const auth = await requireUser(["admin"]);
	if ("error" in auth) return auth.error;
	const { id } = await params;
	const { error } = await auth.sb
		.from("broadcasts")
		.update({
			video_status: "queued",
			video_download_attempts: 0,
			video_error: null,
		})
		.eq("id", id);
	if (error) return NextResponse.json({ error: error.message }, { status: 500 });
	return NextResponse.json({ ok: true });
}
