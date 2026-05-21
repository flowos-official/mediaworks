/**
 * Apply the 2026-05-21 rakuten_cross_match migration directly via the
 * Supabase Postgres connection. One-off helper for development; production
 * should apply migrations through the Supabase CLI / Studio.
 */

import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { readFile } from "node:fs/promises";

async function main() {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) throw new Error("missing supabase env");

	const sql = await readFile(
		"supabase/migrations/2026-05-21_rakuten_cross_match.sql",
		"utf8",
	);

	// Use the PostgREST admin RPC if available; otherwise instruct user to
	// apply via Studio. Supabase doesn't expose raw SQL over the data API
	// directly, but most projects expose an `exec_sql` RPC for migrations.
	const res = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
		method: "POST",
		headers: {
			apikey: key,
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ sql }),
	});

	if (!res.ok) {
		const txt = await res.text();
		console.error(
			`RPC exec_sql failed (${res.status}): ${txt.slice(0, 300)}\n\nPlease apply manually via Supabase Studio:\n${sql}`,
		);
		process.exit(1);
	}
	console.log("✓ Migration applied:", await res.text());
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
