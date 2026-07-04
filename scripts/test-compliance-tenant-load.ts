import { loadActiveRules, loadActiveReferences } from "../lib/screenplay/compliance/check";
import { getServiceClient } from "../lib/supabase";

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else console.log(`✓ ${msg}`);
}

async function main() {
	if (!process.env.SUPABASE_SERVICE_ROLE_KEY) { console.log("SKIP: no service key"); return; }
	const sb = getServiceClient();
	const stamp = Date.now();
	const tt = await sb.from("compliance_rules")
		.insert({ law: "keihyo", pattern: `__tt_only_${stamp}`, tenant: "tokyo_tv", active: true }).select("id").single();

	try {
		const mw = await loadActiveRules();               // default 'mediaworks'
		assert(!mw.some((r) => r.pattern === `__tt_only_${stamp}`), "default tenant load excludes tokyo_tv rule");
		const tv = await loadActiveRules("tokyo_tv");
		assert(tv.some((r) => r.pattern === `__tt_only_${stamp}`), "tokyo_tv load includes its own rule");
		const refs = await loadActiveReferences("tokyo_tv");
		assert(Array.isArray(refs), "loadActiveReferences(tenant) returns array");
	} finally {
		if (tt.data?.id) await sb.from("compliance_rules").delete().eq("id", tt.data.id);
	}
}
main();
