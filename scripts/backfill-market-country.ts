/**
 * Re-tag Japanese rows that were persisted as country='kr'.
 *
 * Background: the shared JP/KR tables carry `country` with DEFAULT 'kr'. The
 * production JP deployment predates the market work and never sets the column,
 * so every JP row scraped since the column was introduced landed as Korean.
 * This script restores the correct tag using the same evidence the runtime
 * visibility filter uses, and never touches rows that are genuinely Korean.
 *
 * Dry-run by default:  npm run backfill:market-country
 * Apply the updates:   npm run backfill:market-country -- --apply
 */
import { mkdir, writeFile } from "node:fs/promises";
import { getServiceClient } from "@/lib/supabase";
import { ALL_CHANNELS, DELISTED_CALENDAR_CHANNELS } from "@/lib/broadcasts/channel-style";
import { isKoreanMarketRecord } from "@/lib/market/data-visibility";

const APPLY = process.argv.includes("--apply");
const PAGE = 1000;
const UPDATE_CHUNK = 200;

const JP_CHANNELS = new Set<string>([
	...ALL_CHANNELS.map((c) => c.slug as string),
	...DELISTED_CALENDAR_CHANNELS,
]);

/** Korean channel slugs written by the LOTTE deployment. */
const KR_CHANNELS = new Set([
	"cjonstyle",
	"lotteimall",
	"gongyoungshop",
	"hnsmall",
	"hmall",
	"nsmall",
	"gsshop",
]);

/** JP shopping hosts that do not end in .jp. */
const JP_HOSTS = ["tokai-tv.com", "shopch.jp", "qvc.jp"];

const HANGUL_RE = /[ㄱ-ㆎ가-힣]/g;
const JAPANESE_RE = /[぀-ヿ]/g;

type Row = Record<string, unknown>;
type Verdict = "to_jp" | "keep_kr" | "ambiguous";

const sb = getServiceClient();

function host(value: unknown): string {
	if (typeof value !== "string" || !value) return "";
	try {
		return new URL(value).hostname.toLowerCase();
	} catch {
		return "";
	}
}

function text(row: Row, keys: string[]): string {
	return keys
		.map((k) => (typeof row[k] === "string" ? (row[k] as string) : ""))
		.filter(Boolean)
		.join(" ");
}

/** Positive Japanese evidence — absence of Korean evidence is not enough. */
function hasJapaneseEvidence(row: Row, textKeys: string[]): boolean {
	const h = host(row.product_url ?? row.source_url ?? row.url);
	if (h.endsWith(".jp") || JP_HOSTS.some((d) => h === d || h.endsWith(`.${d}`))) return true;

	const t = text(row, textKeys);
	const kana = t.match(JAPANESE_RE)?.length ?? 0;
	const hangul = t.match(HANGUL_RE)?.length ?? 0;
	return kana > 0 && hangul === 0;
}

async function fetchAll(table: string, columns: string): Promise<Row[]> {
	const out: Row[] = [];
	for (let from = 0; ; from += PAGE) {
		const { data, error } = await sb
			.from(table)
			.select(columns)
			.eq("country", "kr")
			.order("id", { ascending: true })
			.range(from, from + PAGE - 1);
		if (error) throw new Error(`${table}: ${error.message}`);
		out.push(...((data ?? []) as unknown as Row[]));
		if (!data || data.length < PAGE) return out;
	}
}

async function applyUpdates(table: string, ids: string[]): Promise<void> {
	for (let i = 0; i < ids.length; i += UPDATE_CHUNK) {
		const chunk = ids.slice(i, i + UPDATE_CHUNK);
		const { error } = await sb
			.from(table)
			.update({ country: "jp" })
			.eq("country", "kr") // defensive: never re-tag a row someone already fixed
			.in("id", chunk);
		if (error) throw new Error(`${table} update failed: ${error.message}`);
	}
}

function report(table: string, buckets: Map<Verdict, Row[]>, sampleKeys: string[]): void {
	const toJp = buckets.get("to_jp") ?? [];
	const keep = buckets.get("keep_kr") ?? [];
	const amb = buckets.get("ambiguous") ?? [];
	console.log(`\n── ${table} (country='kr' 대상 ${toJp.length + keep.length + amb.length}행)`);
	console.log(`   jp 로 변경  : ${toJp.length}행`);
	console.log(`   kr 유지     : ${keep.length}행`);
	console.log(`   판단 보류   : ${amb.length}행`);
	for (const [label, rows] of [
		["변경 예시", toJp],
		["유지 예시", keep],
		["보류 예시", amb],
	] as const) {
		for (const r of rows.slice(0, 3))
			console.log(`     [${label}] ${sampleKeys.map((k) => String(r[k] ?? "")).join(" | ").slice(0, 110)}`);
	}
}

async function byChannel(table: string, columns: string, sampleKeys: string[]) {
	const rows = await fetchAll(table, columns);
	const buckets = new Map<Verdict, Row[]>();
	for (const r of rows) {
		const ch = String(r.channel ?? "").toLowerCase();
		const verdict: Verdict = JP_CHANNELS.has(ch) ? "to_jp" : KR_CHANNELS.has(ch) ? "keep_kr" : "ambiguous";
		buckets.set(verdict, [...(buckets.get(verdict) ?? []), r]);
	}
	report(table, buckets, sampleKeys);
	return (buckets.get("to_jp") ?? []).map((r) => String(r.id));
}

async function main() {
	console.log(`=== 시장 country 백필 (${APPLY ? "APPLY — 실제 반영" : "DRY-RUN — 조회만"}) ===`);

	const broadcastIds = await byChannel(
		"broadcasts",
		"id, channel, air_date, program_title, source_url",
		["air_date", "channel", "program_title"],
	);
	const historicalIds = await byChannel(
		"historical_broadcasts",
		"id, channel, air_date, product_name, source_url",
		["air_date", "channel", "product_name"],
	);

	// discovered_products: no channel column, so classify on URL host + script mix.
	const products = await fetchAll(
		"discovered_products",
		"id, session_id, name, product_url, source, tv_channel_source, context, created_at, tv_fit_reason",
	);
	const productBuckets = new Map<Verdict, Row[]>();
	for (const r of products) {
		const korean = isKoreanMarketRecord(r);
		const japanese = hasJapaneseEvidence(r, ["name", "tv_fit_reason"]);
		const verdict: Verdict = korean ? "keep_kr" : japanese ? "to_jp" : "ambiguous";
		productBuckets.set(verdict, [...(productBuckets.get(verdict) ?? []), r]);
	}
	report("discovered_products", productBuckets, ["created_at", "source", "name"]);
	const productIds = (productBuckets.get("to_jp") ?? []).map((r) => String(r.id));

	// discovery_runs: follow the majority verdict of the products the run produced.
	const runs = await fetchAll("discovery_runs", "id, run_at, context, status, produced_count");
	const runBuckets = new Map<Verdict, Row[]>();
	const jpProductIds = new Set(productIds);
	const runProducts = new Map<string, { jp: number; total: number }>();
	for (const p of products) {
		const sid = String(p.session_id ?? "");
		if (!sid) continue;
		const e = runProducts.get(sid) ?? { jp: 0, total: 0 };
		e.total++;
		if (jpProductIds.has(String(p.id))) e.jp++;
		runProducts.set(sid, e);
	}
	for (const r of runs) {
		const stat = runProducts.get(String(r.id));
		const verdict: Verdict = !stat
			? "ambiguous"
			: stat.jp / stat.total >= 0.5
				? "to_jp"
				: "keep_kr";
		runBuckets.set(verdict, [...(runBuckets.get(verdict) ?? []), r]);
	}
	report("discovery_runs", runBuckets, ["run_at", "context", "status"]);
	const runIds = (runBuckets.get("to_jp") ?? []).map((r) => String(r.id));

	// research_results: small table, report every row for manual confirmation.
	const research = await fetchAll("research_results", "id, product_id, created_at, raw_json");
	console.log(`\n── research_results (country='kr' ${research.length}행) — 수동 확인 대상`);
	for (const r of research) {
		const raw = JSON.stringify(r.raw_json ?? {}).slice(0, 160);
		console.log(`     ${String(r.created_at).slice(0, 19)} product_id=${r.product_id} ${raw}`);
	}

	const total = broadcastIds.length + historicalIds.length + productIds.length + runIds.length;
	console.log(`\n=== 합계: ${total}행을 country='jp' 로 변경 예정 ===`);
	console.log(
		`    broadcasts=${broadcastIds.length}, historical_broadcasts=${historicalIds.length}, ` +
			`discovered_products=${productIds.length}, discovery_runs=${runIds.length}`,
	);

	if (!APPLY) {
		console.log("\n(dry-run 이므로 아무것도 변경하지 않았습니다. 반영하려면 -- --apply)");
		return;
	}

	// Rollback record: the exact ids flipped, so the change can be undone with a
	// country='kr' update restricted to these ids.
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const rollbackPath = `tmp/backfill-market-country-${stamp}.json`;
	await mkdir("tmp", { recursive: true });
	await writeFile(
		rollbackPath,
		JSON.stringify(
			{
				applied_at: new Date().toISOString(),
				from: "kr",
				to: "jp",
				ids: {
					broadcasts: broadcastIds,
					historical_broadcasts: historicalIds,
					discovered_products: productIds,
					discovery_runs: runIds,
				},
			},
			null,
			2,
		),
	);
	console.log(`\n롤백 파일: ${rollbackPath}`);

	await applyUpdates("broadcasts", broadcastIds);
	await applyUpdates("historical_broadcasts", historicalIds);
	await applyUpdates("discovered_products", productIds);
	await applyUpdates("discovery_runs", runIds);
	console.log("✅ 반영 완료");
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
