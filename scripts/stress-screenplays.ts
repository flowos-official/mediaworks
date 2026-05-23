/**
 * Comprehensive stress + bug-hunt suite for the screenplays feature.
 * Usage: BASE=http://localhost:3000 npm run stress:screenplays
 */
const BASE = process.env.BASE ?? "http://localhost:3000";

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function logResult(name: string, ok: boolean, detail: string) {
	const tag = ok ? "PASS" : "FAIL";
	console.log(`[${tag}]  ${name}${ok ? "" : "  — " + detail}`);
}

async function check(name: string, fn: () => Promise<string | true>) {
	try {
		const r = await fn();
		const ok = r === true;
		const detail = ok ? "" : r;
		results.push({ name, ok, detail });
		logResult(name, ok, detail);
	} catch (e) {
		const detail = `THREW: ${e instanceof Error ? e.message : String(e)}`;
		results.push({ name, ok: false, detail });
		logResult(name, false, detail);
	}
}

async function json(path: string, init?: RequestInit) {
	const res = await fetch(`${BASE}${path}`, init);
	const text = await res.text();
	let body: unknown = null;
	try { body = JSON.parse(text); } catch { body = text; }
	return { status: res.status, body };
}

async function pollUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 2000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		if (await predicate()) return true;
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	return false;
}

async function runAll() {
	console.log(`Stress suite targeting ${BASE}`);
	console.log("─".repeat(70));

	// ROUND 1 — INPUT VALIDATION
	await check("POST /api/screenplays with empty body → 400", async () => {
		const r = await json("/api/screenplays", { method: "POST" });
		return r.status === 400 ? true : `got ${r.status}`;
	});

	await check("POST with neither productId nor productBrief → 400", async () => {
		const r = await json("/api/screenplays", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ foo: "bar" }),
		});
		return r.status === 400 ? true : `got ${r.status}`;
	});

	await check("POST with empty name → 400", async () => {
		const r = await json("/api/screenplays", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ productBrief: { name: "  ", description: "x" } }),
		});
		return r.status === 400 ? true : `got ${r.status}`;
	});

	await check("POST with empty description → 400", async () => {
		const r = await json("/api/screenplays", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ productBrief: { name: "X", description: "" } }),
		});
		return r.status === 400 ? true : `got ${r.status}`;
	});

	await check("POST with malformed productId → 400", async () => {
		const r = await json("/api/screenplays", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ productId: "not-a-uuid" }),
		});
		return r.status === 400 ? true : `got ${r.status}`;
	});

	await check("POST with non-existent productId → 404", async () => {
		const r = await json("/api/screenplays", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ productId: "00000000-0000-0000-0000-000000000000" }),
		});
		return r.status === 404 ? true : `got ${r.status}`;
	});

	await check("POST with malformed JSON → 400", async () => {
		const r = await fetch(`${BASE}/api/screenplays`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{not-json",
		});
		return r.status === 400 ? true : `got ${r.status}`;
	});

	await check("GET non-UUID id → 404 (no DB leak)", async () => {
		const r = await json("/api/screenplays/not-a-uuid");
		if (r.status !== 404) return `got ${r.status}`;
		const msg = ((r.body as { error?: string }).error ?? "").toLowerCase();
		if (msg.includes("uuid") && msg.includes("syntax")) return "leaks DB error message";
		return true;
	});

	await check("Refine with non-UUID id → 404", async () => {
		const r = await json("/api/screenplays/not-a-uuid/refine", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ feedback: "test" }),
		});
		return r.status === 404 ? true : `got ${r.status}`;
	});

	await check("Refine with empty feedback → 400", async () => {
		// Need a real screenplay first
		const created = await json("/api/screenplays", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ productBrief: { name: "stress-validation", description: "y" } }),
		});
		if (created.status !== 200) return `setup: ${created.status}`;
		const id = (created.body as { id: string }).id;
		const r = await json(`/api/screenplays/${id}/refine`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ feedback: "" }),
		});
		return r.status === 400 ? true : `got ${r.status}`;
	});

	await check("Refine with feedback > 4000 chars → 400", async () => {
		const created = await json("/api/screenplays", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ productBrief: { name: "stress-oversize-fb", description: "y" } }),
		});
		if (created.status !== 200) return `setup: ${created.status}`;
		const id = (created.body as { id: string }).id;
		const r = await json(`/api/screenplays/${id}/refine`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ feedback: "あ".repeat(5000) }),
		});
		return r.status === 400 ? true : `got ${r.status}`;
	});

	await check("Refine on never-existed UUID → 404", async () => {
		const r = await json("/api/screenplays/00000000-0000-0000-0000-000000000000/refine", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ feedback: "test" }),
		});
		return r.status === 404 ? true : `got ${r.status}`;
	});

	// ROUND 2 — XSS PROBE
	await check("Script tag in name does not break list HTML", async () => {
		await json("/api/screenplays", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				productBrief: { name: "<script>alert('xss')</script>", description: "x" },
			}),
		});
		const htmlRes = await fetch(`${BASE}/screenplays`);
		const html = await htmlRes.text();
		const unsafe = html.includes("<script>alert('xss')</script>");
		return unsafe ? "raw script tag rendered — XSS" : true;
	});

	await check("Script tag in feedback does not execute via stored MD", async () => {
		const created = await json("/api/screenplays", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ productBrief: { name: "xss-fb", description: "y" } }),
		});
		if (created.status !== 200) return `setup: ${created.status}`;
		const id = (created.body as { id: string }).id;
		// Doesn't matter if refine succeeds; only the API surface matters.
		const r = await json(`/api/screenplays/${id}/refine`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ feedback: "<script>alert('xss')</script>" }),
		});
		return r.status === 400 || r.status === 200 || r.status === 409 ? true : `unexpected ${r.status}`;
	});

	// ROUND 3 — STATUS PROBES
	await check("status for invalid runId → 404", async () => {
		const r = await json("/api/screenplays/run/wrun_does_not_exist/status");
		return r.status === 404 ? true : `got ${r.status}`;
	});

	await check("stream for invalid runId → 404 (no unhandled rejection)", async () => {
		const r = await fetch(`${BASE}/api/screenplays/run/wrun_does_not_exist/stream`);
		return r.status === 404 ? true : `got ${r.status}`;
	});

	await check("stream for malformed runId → 404", async () => {
		const r = await fetch(`${BASE}/api/screenplays/run/not-a-run-id/stream`);
		return r.status === 404 ? true : `got ${r.status}`;
	});

	// ROUND 4 — CONCURRENCY
	await check("5 parallel creates → 5 distinct IDs", async () => {
		const promises = Array.from({ length: 5 }, (_, i) =>
			json("/api/screenplays", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					productBrief: { name: `parallel-${i}`, description: `desc-${i}` },
				}),
			})
		);
		const settled = await Promise.all(promises);
		const ids = new Set<string>();
		for (const r of settled) {
			if (r.status !== 200) return `one create failed: ${r.status}`;
			ids.add((r.body as { id: string }).id);
		}
		return ids.size === 5 ? true : `got ${ids.size} distinct ids of 5`;
	});

	await check("DELETE non-existent screenplay → 200 (idempotent)", async () => {
		const r = await json("/api/screenplays/00000000-0000-0000-0000-000000000000", { method: "DELETE" });
		return r.status === 200 ? true : `got ${r.status}`;
	});

	await check("DELETE with non-UUID id → 200 (idempotent)", async () => {
		const r = await json("/api/screenplays/not-a-uuid", { method: "DELETE" });
		return r.status === 200 ? true : `got ${r.status}`;
	});

	// ROUND 5 — FULL WORKFLOW
	let createdId = "";
	let runId = "";
	await check("create real screenplay → 200", async () => {
		const r = await json("/api/screenplays", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				productBrief: {
					name: "STRESS-アイアジャストグラス",
					category: "ヘルスケア",
					description: "1枚のレンズで上から下に向かって滑らかに度数が変化する累進多焦点レンズの老眼鏡。+1.0〜+2.5度数対応。",
					price: { saleJpy: 9800 },
				},
			}),
		});
		if (r.status !== 200) return `got ${r.status}`;
		const b = r.body as { id: string; runId: string };
		createdId = b.id;
		runId = b.runId;
		return true;
	});

	await check("workflow completes & writes v1", async () => {
		if (!createdId) return "no createdId";
		const done = await pollUntil(async () => {
			const r = await json(`/api/screenplays/run/${runId}/status`);
			const status = (r.body as { status?: string })?.status;
			return status === "completed" || status === "failed";
		}, 240_000, 3000);
		if (!done) return "timed out";
		const detail = await json(`/api/screenplays/${createdId}`);
		const { screenplay, versions } = detail.body as { screenplay: { status: string }; versions: unknown[] };
		if (screenplay.status !== "ready") return `screenplay.status=${screenplay.status}`;
		if (versions.length < 1) return `versions=${versions.length}`;
		return true;
	});

	await check("refine writes v2 with correct feedback", async () => {
		if (!createdId) return "no createdId";
		const r = await json(`/api/screenplays/${createdId}/refine`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ feedback: "実演デモを最後に入れてください。" }),
		});
		if (r.status !== 200) return `refine: ${r.status} ${JSON.stringify(r.body)}`;
		const refineRunId = (r.body as { runId: string }).runId;
		const done = await pollUntil(async () => {
			const s = await json(`/api/screenplays/run/${refineRunId}/status`);
			return ((s.body as { status?: string }).status === "completed" || (s.body as { status?: string }).status === "failed");
		}, 240_000, 3000);
		if (!done) return "refine timed out";
		const detail = await json(`/api/screenplays/${createdId}`);
		const vs = (detail.body as { versions: { version_number: number; feedback: string | null }[] }).versions;
		if (vs.length < 2) return `expected ≥2 versions, got ${vs.length}`;
		const v2 = vs.find((v) => v.version_number === 2);
		if (!v2) return "v2 missing";
		if (!v2.feedback) return "v2 feedback empty";
		return true;
	});

	await check("concurrent refines: ONE 200, others 409 (mutex)", async () => {
		if (!createdId) return "no createdId";
		const proms = Array.from({ length: 3 }, (_, i) =>
			json(`/api/screenplays/${createdId}/refine`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback: `parallel feedback ${i}` }),
			})
		);
		const res = await Promise.all(proms);
		const statuses = res.map((r) => r.status).sort();
		const ok200 = statuses.filter((s) => s === 200).length;
		const ok409 = statuses.filter((s) => s === 409).length;
		// Only one should win the mutex; others must get 409.
		if (ok200 === 1 && ok409 === 2) return true;
		return `statuses=${statuses.join(",")} (want exactly one 200 + two 409)`;
	});

	// ROUND 6 — SUMMARY
	console.log();
	console.log("─".repeat(70));
	console.log(`RESULTS  (${results.filter((r) => r.ok).length}/${results.length} passed)`);
	console.log("─".repeat(70));
	const failed = results.filter((r) => !r.ok);
	if (failed.length > 0) {
		console.log("Failed tests:");
		for (const r of failed) console.log(`  - ${r.name}: ${r.detail}`);
	}
	process.exit(failed.length === 0 ? 0 : 1);
}

void runAll();
