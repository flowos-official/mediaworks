import { requireUser } from "@/lib/auth/require-user";
import { loadRecommendationFlowStatus } from "@/lib/recommendation/flow-evidence";
import { getServiceClient } from "@/lib/supabase";

export const maxDuration = 30;

export async function GET() {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	try {
		const status = await loadRecommendationFlowStatus(getServiceClient());
		return Response.json(status);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return Response.json(
			{ error: "recommendation_flow_status_failed", message },
			{ status: 500 },
		);
	}
}
