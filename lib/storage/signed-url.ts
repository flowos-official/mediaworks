import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "@/lib/supabase";

const DEFAULT_TTL_SEC = 3600; // 1h

/**
 * Resolve a storage path to a signed URL with TTL.
 *
 * Pass a custom client (e.g. a server client with a user session) if you want
 * RLS to apply. The default uses the service-role client — safe for callers
 * that have already gated authorization upstream (e.g. report-export, admin
 * tooling) and unsafe to use directly from a route handler that hasn't.
 *
 * No `import "server-only"` so smoke scripts can import. Guard upstream.
 */
export async function createSignedProductFileUrl(
	storagePath: string,
	ttlSec: number = DEFAULT_TTL_SEC,
	client?: SupabaseClient,
): Promise<string> {
	const sb = client ?? getServiceClient();
	const { data, error } = await sb.storage
		.from("product-files")
		.createSignedUrl(storagePath, ttlSec);
	if (error || !data) {
		throw new Error(`Failed to sign product-files URL '${storagePath}': ${error?.message ?? "unknown"}`);
	}
	return data.signedUrl;
}
