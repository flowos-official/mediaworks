import { getServiceClient } from "../lib/supabase";

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else console.log(`✓ ${msg}`);
}

async function main() {
	if (!process.env.SUPABASE_SERVICE_ROLE_KEY) { console.log("SKIP: no service key"); return; }
	const sb = getServiceClient();
	for (const law of ["shokuhin", "tokushoho"]) {
		const r = await sb.from("compliance_rules")
			.insert({ law, pattern: `__foodlaw_${law}_${Date.now()}`, tenant: "tokyo_tv" }).select("id").single();
		assert(!r.error, `compliance_rules accepts law='${law}': ${r.error?.message ?? ""}`);
		if (r.data?.id) await sb.from("compliance_rules").delete().eq("id", r.data.id);
	}
}
main();
