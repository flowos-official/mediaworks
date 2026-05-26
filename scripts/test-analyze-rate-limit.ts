/**
 * Live DB smoke: checkAnalyzeRateLimit の 4 ケース。
 * 実行: npm run test:analyze-rate-limit
 *
 * 前提: 2026-05-26_products_created_by.sql が dev DB に適用済み。
 *       profiles に最低 1 行存在する (smoke は 1 個取得して使う)。
 */
import { createClient } from "@supabase/supabase-js";
import { checkAnalyzeRateLimit } from "../lib/research/analyze-rate-limit";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local に必要");
}
const sb = createClient(url, key, { auth: { persistSession: false } });

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

// Helper reads the same env vars as the helper itself so smoke matches
// whatever the live process is configured for.
const MAX_INFLIGHT = Number(process.env.ANALYZE_MAX_INFLIGHT_PER_USER ?? "3");
const MAX_DAILY = Number(process.env.ANALYZE_MAX_DAILY_PER_USER ?? "20");

async function main(): Promise<void> {
	console.log(`[smoke] limits: inflight=${MAX_INFLIGHT}, daily=${MAX_DAILY}`);

	// Grab any existing profile id to use as the test user
	const { data: profile } = await sb.from("profiles").select("id").limit(1).maybeSingle();
	if (!profile) throw new Error("profiles テーブルに最低 1 行必要");
	const userId = profile.id as string;
	const tag = `rate-limit-smoke-${Date.now()}`;

	// Clean any leftover rows tagged by THIS exact run (defensive — no stale match).
	// We don't clear other smoke runs' rows; parallel runs are not expected.
	await sb.from("products").delete().like("name", `${tag}-%`);

	const tempIds: string[] = [];
	try {
		// Case 1: inflight=0 → ok (insert nothing first)
		const r1 = await checkAnalyzeRateLimit(sb, userId, "member");
		assert(r1.kind === "ok", `inflight=0 should be ok, got ${JSON.stringify(r1)}`);

		// Case 2: insert MAX_INFLIGHT rows in analyzing → next call exceeds
		for (let i = 0; i < MAX_INFLIGHT; i++) {
			const { data, error } = await sb
				.from("products")
				.insert({
					name: `${tag}-inflight-${i}`,
					file_url: "smoke://none",
					file_name: "a.txt",
					status: "analyzing",
					created_by: userId,
				})
				.select("id")
				.single();
			if (error) throw new Error(`insert failed: ${error.message}`);
			tempIds.push((data as { id: string }).id);
		}
		const r2 = await checkAnalyzeRateLimit(sb, userId, "member");
		assert(r2.kind === "inflight_exceeded",
			`inflight=${MAX_INFLIGHT} should exceed, got ${JSON.stringify(r2)}`);

		// Case 3: admin always passes regardless of inflight
		const r3 = await checkAnalyzeRateLimit(sb, userId, "admin");
		assert(r3.kind === "ok",
			`admin role should bypass, got ${JSON.stringify(r3)}`);

		// Case 4: clean inflight, then insert MAX_DAILY completed rows within 24h → daily_exceeded
		await sb.from("products").delete().in("id", tempIds);
		tempIds.length = 0;
		for (let i = 0; i < MAX_DAILY; i++) {
			const { data, error } = await sb
				.from("products")
				.insert({
					name: `${tag}-daily-${i}`,
					file_url: "smoke://none",
					file_name: "a.txt",
					status: "completed",
					created_by: userId,
				})
				.select("id")
				.single();
			if (error) throw new Error(`insert failed: ${error.message}`);
			tempIds.push((data as { id: string }).id);
		}
		const r4 = await checkAnalyzeRateLimit(sb, userId, "member");
		assert(r4.kind === "daily_exceeded",
			`daily=${MAX_DAILY} should exceed, got ${JSON.stringify(r4)}`);

		console.log("[ok] analyze-rate-limit smoke 全4ケース通過");
	} finally {
		if (tempIds.length > 0) {
			await sb.from("products").delete().in("id", tempIds);
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
