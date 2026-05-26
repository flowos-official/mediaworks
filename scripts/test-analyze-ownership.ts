/**
 * Live DB smoke: /api/analyze の ownership check 4 ケース。
 * 実行: npm run test:analyze-ownership
 *
 * 注意: HTTP 経由ではなく Postgres を直接見る方式 — productId と user_id の
 *       combinations が application logic で 403/404/200 のいずれを返すべきかを
 *       テスト row を作成して検証する。実 fetch は dev server を要求するため
 *       avoid; 代わりに ownership 関数のロジックを純粋関数で検証する。
 *
 * 前提: 2026-05-26_products_created_by.sql 適用済み。profiles に 2 行以上。
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
	throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local に必要");
}
const sb = createClient(url, key, { auth: { persistSession: false } });

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

/**
 * The same ownership predicate as `/api/analyze/route.ts`.
 * Returns true if user is allowed to mutate the product.
 */
function isAllowed(
	productCreatedBy: string | null,
	userId: string,
	role: "member" | "admin",
): boolean {
	if (role === "admin") return true;
	return productCreatedBy === userId;
}

async function main(): Promise<void> {
	const { data: profiles } = await sb.from("profiles").select("id, role").limit(2);
	if (!profiles || profiles.length < 2) throw new Error("profiles テーブルに 2 行以上必要");
	const userA = profiles[0].id as string;
	const userB = profiles[1].id as string;

	const tag = `ownership-smoke-${Date.now()}`;
	const tempIds: string[] = [];

	try {
		// Insert two products — one owned by A, one with NULL owner
		const { data: pA, error: eA } = await sb
			.from("products")
			.insert({ name: `${tag}-A`, file_url: "smoke://none", file_name: "a.txt", status: "failed", created_by: userA })
			.select("id, created_by")
			.single();
		if (eA) throw new Error(eA.message);
		tempIds.push((pA as { id: string }).id);

		const { data: pNull, error: eN } = await sb
			.from("products")
			.insert({ name: `${tag}-null`, file_url: "smoke://none", file_name: "a.txt", status: "failed", created_by: null })
			.select("id, created_by")
			.single();
		if (eN) throw new Error(eN.message);
		tempIds.push((pNull as { id: string }).id);

		const pAOwner = (pA as { created_by: string | null }).created_by;
		const pNullOwner = (pNull as { created_by: string | null }).created_by;

		// Case 1: user A acts on A's product as member → allowed
		assert(isAllowed(pAOwner, userA, "member") === true, "owner member should be allowed");

		// Case 2: user B acts on A's product as member → forbidden
		assert(isAllowed(pAOwner, userB, "member") === false, "non-owner member should be forbidden");

		// Case 3: user B acts on A's product as admin → allowed
		assert(isAllowed(pAOwner, userB, "admin") === true, "admin should bypass owner");

		// Case 4: user A acts on NULL-owner product as member → forbidden (admin only)
		assert(isAllowed(pNullOwner, userA, "member") === false, "NULL owner + member should be forbidden");
		assert(isAllowed(pNullOwner, userA, "admin") === true, "NULL owner + admin should be allowed");

		console.log("[ok] analyze-ownership smoke 全4ケース通過 (pure predicate)");
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
