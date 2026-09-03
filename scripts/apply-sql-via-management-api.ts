/**
 * Apply one SQL file to the linked Supabase project via the Management API.
 *
 * `scripts/apply-sql-file.ts` needs SUPABASE_DB_PASSWORD, which this repo's
 * .env.local does not carry, and `supabase db push` is unusable here because
 * the remote migration history is out of sync with supabase/migrations/ — most
 * of these were applied by hand through Studio, so a push would re-run them.
 *
 * This runs exactly the file named on the command line and nothing else. The
 * access token comes from the Supabase CLI's own keychain entry, so it works
 * only on a machine where `supabase login` has already happened.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const PROJECT_REF = "sdgxuyigfpmzgxnnoiwf";

function accessToken(): string {
	const fromEnv = process.env.SUPABASE_ACCESS_TOKEN;
	if (fromEnv) return fromEnv;
	try {
		const raw = execFileSync(
			"security",
			["find-generic-password", "-s", "Supabase CLI", "-w"],
			{ encoding: "utf8" },
		).trim();
		// go-keyring stores non-ASCII-safe values base64-encoded behind this
		// marker; the CLI's token lands there, so strip it before use.
		const marker = "go-keyring-base64:";
		return raw.startsWith(marker)
			? Buffer.from(raw.slice(marker.length), "base64").toString("utf8")
			: raw;
	} catch {
		throw new Error(
			"no access token: set SUPABASE_ACCESS_TOKEN or run `supabase login`",
		);
	}
}

async function main(): Promise<void> {
	const file = process.argv[2];
	if (!file) {
		console.error(
			"usage: npm run db:apply-api <file.sql>",
		);
		process.exit(1);
	}

	const query = readFileSync(file, "utf8");
	console.log(`[apply-api] ${file} (${query.length} chars) → ${PROJECT_REF}`);

	const res = await fetch(
		`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken()}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query }),
		},
	);

	const text = await res.text();
	if (!res.ok) {
		console.error(`[apply-api] ✗ ${res.status}: ${text.slice(0, 600)}`);
		process.exit(1);
	}
	console.log(`[apply-api] ✓ ${res.status} ${text.slice(0, 300)}`);
}

main().catch((e) => {
	console.error("[apply-api] FATAL:", e instanceof Error ? e.message : e);
	process.exit(1);
});
