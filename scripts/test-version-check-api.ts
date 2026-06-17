import { getServiceClient } from "../lib/supabase";

let pass = 0, fail = 0, skip = 0;
function ok(name: string, cond: boolean, detail = "") {
	if (cond) { pass++; console.log(`  ✅ ${name}`); }
	else { fail++; console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); }
}

async function main() {
	console.log("\n=== version-check API query semantics ===\n");
	const hasEnv = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!process.env.NEXT_PUBLIC_SUPABASE_URL;
	if (!hasEnv) { console.log("  ⏭ skip (no Supabase env)"); skip++; console.log(`\n=== ${pass} pass, ${fail} fail, ${skip} skip ===`); return; }

	const sb = getServiceClient();

	// Pick two distinct screenplays each with >=1 version.
	const { data: sps } = await sb.from("screenplays").select("id").limit(5);
	if (!sps || sps.length < 1) { console.log("  ⏭ skip (no screenplays)"); skip++; console.log(`\n=== ${pass} pass, ${fail} fail, ${skip} skip ===`); return; }

	const spA = sps[0].id;
	const { data: versA } = await sb.from("screenplay_versions").select("id").eq("screenplay_id", spA).limit(1);
	ok("screenplay A has a version", !!versA && versA.length > 0);
	if (!versA?.length) { console.log(`\n=== ${pass} pass, ${fail} fail, ${skip} skip ===`); return; }
	const verA = versA[0].id;

	// Ownership filter: verA must resolve under spA, and NOT under a different screenplay id.
	const { data: owned } = await sb.from("screenplay_versions").select("id").eq("id", verA).eq("screenplay_id", spA).maybeSingle();
	ok("owned version resolves under its screenplay", !!owned && owned.id === verA);

	const otherSp = sps.find((s) => s.id !== spA)?.id ?? "00000000-0000-0000-0000-000000000000";
	const { data: notOwned } = await sb.from("screenplay_versions").select("id").eq("id", verA).eq("screenplay_id", otherSp).maybeSingle();
	ok("version is rejected under a different screenplay id", notOwned === null);

	// Latest-check fetch shape (may legitimately be null if never checked).
	const { data: chk, error: chkErr } = await sb
		.from("screenplay_version_checks")
		.select("id, overall_score, result, created_at, is_auto, lexicon_version")
		.eq("version_id", verA).order("created_at", { ascending: false }).limit(1).maybeSingle();
	ok("latest-check query runs without error", !chkErr, chkErr?.message);
	ok("check is null or has result object", chk === null || typeof chk.result === "object");

	console.log(`\n=== ${pass} pass, ${fail} fail, ${skip} skip ===`);
	if (fail > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
