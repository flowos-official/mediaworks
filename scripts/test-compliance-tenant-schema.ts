import { getServiceClient } from "../lib/supabase";

function assert(cond: boolean, msg: string) {
	if (!cond) { console.error(`✗ ${msg}`); process.exitCode = 1; }
	else console.log(`✓ ${msg}`);
}

async function main() {
	if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
		console.log("SKIP: no SUPABASE_SERVICE_ROLE_KEY (run with --env-file=.env.local)");
		return;
	}
	const sb = getServiceClient();

	// tenant column exists with default 'mediaworks' on both corpus tables.
	const rule = await sb.from("compliance_rules")
		.insert({ law: "yakkiho", pattern: `__tenant_probe_${Date.now()}` })
		.select("id,tenant").single();
	assert(!rule.error, `insert compliance_rules ok: ${rule.error?.message ?? ""}`);
	assert(rule.data?.tenant === "mediaworks", "compliance_rules.tenant defaults to 'mediaworks'");
	if (rule.data?.id) await sb.from("compliance_rules").delete().eq("id", rule.data.id);

	const ref = await sb.from("compliance_references")
		.insert({ law: "other", topic: `__tenant_probe_${Date.now()}`, body: "x" })
		.select("id,tenant").single();
	assert(!ref.error, `insert compliance_references ok: ${ref.error?.message ?? ""}`);
	assert(ref.data?.tenant === "mediaworks", "compliance_references.tenant defaults to 'mediaworks'");
	if (ref.data?.id) await sb.from("compliance_references").delete().eq("id", ref.data.id);

	// UNIQUE now includes tenant: same (law,pattern) under two tenants must coexist.
	const p = `__tenant_uniq_${Date.now()}`;
	const a = await sb.from("compliance_rules").insert({ law: "keihyo", pattern: p, tenant: "mediaworks" }).select("id").single();
	const b = await sb.from("compliance_rules").insert({ law: "keihyo", pattern: p, tenant: "tokyo_tv" }).select("id").single();
	assert(!a.error && !b.error, `same (law,pattern) coexists across tenants: ${a.error?.message ?? ""} ${b.error?.message ?? ""}`);
	for (const id of [a.data?.id, b.data?.id]) if (id) await sb.from("compliance_rules").delete().eq("id", id);
}
main();
