import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import {
	PromotionError,
	promoteDiscoveredProductToResearch,
} from "@/lib/discovery/promote-to-research";

export const maxDuration = 60;

export async function POST(
	_request: NextRequest,
	{ params }: { params: Promise<{ productId: string }> },
) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const { productId: dpId } = await params;
	if (!dpId) {
		return NextResponse.json({ error: "productId required" }, { status: 400 });
	}

	// Service client: products is Group B (member/admin only). The user is already
	// authorized via requireUser above; service client is used here to avoid the
	// extra cookie-roundtrip cost on a server-only path.
	const sb = getServiceClient();

	try {
		const result = await promoteDiscoveredProductToResearch(sb, dpId, {
			triggerSynthesis: true,
		});
		return NextResponse.json(result);
	} catch (err) {
		if (err instanceof PromotionError) {
			if (err.status >= 500) {
				console.error("[promote-to-research] failed", err.cause ?? err);
			}
			return NextResponse.json({ error: err.message }, { status: err.status });
		}
		console.error("[promote-to-research] unexpected failure", err);
		return NextResponse.json({ error: "promotion failed" }, { status: 500 });
	}
}
