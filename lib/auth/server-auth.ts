import type { SupabaseClient, User } from "@supabase/supabase-js";
import { getServerClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/auth/route-permissions";

export type ServerAuthResult =
	| { ok: true; user: User; role: Role; sb: SupabaseClient }
	| { ok: false; reason: "unauthorized" | "forbidden"; sb: SupabaseClient };

/**
 * Server Component friendly auth helper. API routes should keep using
 * requireUser(), which returns HTTP responses instead of redirect decisions.
 */
export async function getServerAuth(allowed?: readonly Role[]): Promise<ServerAuthResult> {
	const sb = await getServerClient();
	const {
		data: { user },
		error,
	} = await sb.auth.getUser();

	if (error || !user) return { ok: false, reason: "unauthorized", sb };

	const { data: profile } = await sb
		.from("profiles")
		.select("role")
		.eq("id", user.id)
		.maybeSingle();

	const role = profile?.role as Role | undefined;
	if (!role || (allowed && !allowed.includes(role))) {
		return { ok: false, reason: "forbidden", sb };
	}

	return { ok: true, user, role, sb };
}
