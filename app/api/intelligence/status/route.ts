import { requireUser } from "@/lib/auth/require-user";
import { loadIntelligenceReadiness } from "@/lib/intelligence/readiness";
import { getServiceClient } from "@/lib/supabase";

const STATUS_HEADERS = { "Cache-Control": "private, no-store" };

export interface IntelligenceStatusRouteDependencies {
	requireUser: typeof requireUser;
	getServiceClient: typeof getServiceClient;
	loadIntelligenceReadiness: typeof loadIntelligenceReadiness;
	now?: () => Date;
}

/** Injectable boundary keeps route behavior testable without a live service client. */
export async function intelligenceStatusGet(
	dependencies: IntelligenceStatusRouteDependencies = {
		requireUser,
		getServiceClient,
		loadIntelligenceReadiness,
	},
): Promise<Response> {
	const auth = await dependencies.requireUser(["viewer", "member", "admin"]);
	if ("error" in auth) {
		auth.error.headers.set("Cache-Control", STATUS_HEADERS["Cache-Control"]);
		return auth.error;
	}

	try {
		const readiness = await dependencies.loadIntelligenceReadiness(
			dependencies.getServiceClient(),
			(dependencies.now ?? (() => new Date()))(),
		);
		return Response.json(readiness, { headers: STATUS_HEADERS });
	} catch {
		return Response.json({ error: "intelligence_status_failed" }, { status: 500, headers: STATUS_HEADERS });
	}
}

export async function GET(): Promise<Response> {
	return intelligenceStatusGet();
}
