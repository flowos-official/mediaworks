/**
 * Live DB smoke for stuck-detector. dev Supabase に直接接続する。
 * 実行: npm run test:research-stuck-detector
 *
 * 検証内容:
 *   1) status='pending', created_at が 11 分前の row → trigger_not_invoked で failed 化
 *   2) status='analyzing', updated_at が 11 分前の row → analysis_timeout で failed 化
 *   3) status='analyzing', updated_at が 5 分前の row (まだ新しい) → 変化しない
 *   4) status='completed' の row → 影響なし
 *
 * 終了時は全 temp row を DELETE する。
 */
import { createClient } from "@supabase/supabase-js";
import { detectStuck } from "../lib/research/stuck-detector";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が .env.local に必要");
}
const sb = createClient(url, key, { auth: { persistSession: false } });

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function isoMinutesAgo(min: number): string {
  return new Date(Date.now() - min * 60 * 1000).toISOString();
}

async function main(): Promise<void> {
  const tag = `stuck-smoke-${Date.now()}`;

  // 4 temp products を挿入。
  // 注意: products_updated_at_trigger は BEFORE UPDATE のみで発火する。
  // INSERT 時に updated_at を明示すれば trigger を経由せずその値で着地する。
  const inserts = [
    { name: `${tag}-pending-stuck`,    file_url: "smoke://none", file_name: "a.txt", status: "pending",   created_at: isoMinutesAgo(11), updated_at: isoMinutesAgo(11) },
    { name: `${tag}-analyzing-stuck`,  file_url: "smoke://none", file_name: "b.txt", status: "analyzing", created_at: isoMinutesAgo(30), updated_at: isoMinutesAgo(11) },
    { name: `${tag}-analyzing-fresh`,  file_url: "smoke://none", file_name: "c.txt", status: "analyzing", created_at: isoMinutesAgo(30), updated_at: isoMinutesAgo(5)  },
    { name: `${tag}-completed`,        file_url: "smoke://none", file_name: "d.txt", status: "completed", created_at: isoMinutesAgo(30), updated_at: isoMinutesAgo(30) },
  ];
  const { data: rows, error: insErr } = await sb
    .from("products")
    .insert(inserts)
    .select("id, name, updated_at");
  if (insErr) throw new Error(`temp insert 失敗: ${insErr.message}`);
  assert(rows && rows.length === 4, "4 temp rows 挿入したはず");

  const byName = new Map(rows!.map((r) => [r.name, r.id]));
  const pendingStuckId   = byName.get(`${tag}-pending-stuck`)!;
  const analyzingStuckId = byName.get(`${tag}-analyzing-stuck`)!;
  const analyzingFreshId = byName.get(`${tag}-analyzing-fresh`)!;
  const completedId      = byName.get(`${tag}-completed`)!;

  try {
    const result = await detectStuck(sb);

    const { data: pAfter } = await sb.from("products").select("status, error_reason").eq("id", pendingStuckId).single();
    assert(pAfter?.status === "failed", `pending-stuck は failed に変わるべき (got ${pAfter?.status})`);
    assert(pAfter?.error_reason === "trigger_not_invoked", `error_reason='trigger_not_invoked' のはず (got ${pAfter?.error_reason})`);

    const { data: aAfter } = await sb.from("products").select("status, error_reason").eq("id", analyzingStuckId).single();
    assert(aAfter?.status === "failed", `analyzing-stuck は failed に変わるべき (got ${aAfter?.status})`);
    assert(aAfter?.error_reason === "analysis_timeout", `error_reason='analysis_timeout' のはず (got ${aAfter?.error_reason})`);

    const { data: fAfter } = await sb.from("products").select("status").eq("id", analyzingFreshId).single();
    assert(fAfter?.status === "analyzing", `analyzing-fresh は触らないはず (got ${fAfter?.status})`);

    const { data: cAfter } = await sb.from("products").select("status").eq("id", completedId).single();
    assert(cAfter?.status === "completed", `completed は触らないはず (got ${cAfter?.status})`);

    // detectStuck が件数を返している (他の偶発 stuck row が居ても >= 1 で OK)
    assert(result.flagged.pending >= 1, `flagged.pending >= 1 のはず (got ${result.flagged.pending})`);
    assert(result.flagged.analyzing >= 1, `flagged.analyzing >= 1 のはず (got ${result.flagged.analyzing})`);

    console.log("[ok] detectStuck smoke 通過", result);
  } finally {
    await sb.from("products").delete().in("id", [pendingStuckId, analyzingStuckId, analyzingFreshId, completedId]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
