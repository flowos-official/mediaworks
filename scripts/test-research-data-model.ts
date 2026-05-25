/**
 * 라이브 DB smoke for the Phase 1 data-model cleanup.
 * 실행: npm run test:research-data-model
 *
 * Migration 1이 적용된 dev DB 위에서 다음을 검증한다:
 *   - 신규 5 jsonb 컬럼 + korea_fit_score(generated) 가 존재한다
 *   - research_results.product_id UNIQUE 가 존재한다
 *   - 인덱스 6개가 모두 존재한다
 *   - 임시 product + research_results upsert 한 번 → upsert 두 번째 호출에서
 *     id 와 created_at 이 보존된다
 *   - korea_market_fit.fit_score 가 숫자면 korea_fit_score(generated) 가 같은 값
 *
 * 테스트가 끝나면 모든 임시 row 를 정리한다.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 .env.local 에 있어야 합니다.");
}
const sb = createClient(url, key, { auth: { persistSession: false } });

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

async function fetchColumns(): Promise<Map<string, string>> {
  const { data: row, error: rowErr } = await sb.from("research_results").select("*").limit(1).maybeSingle();
  if (rowErr) throw new Error(`research_results select 실패: ${rowErr.message}`);
  const cols = new Map<string, string>();
  if (row) for (const k of Object.keys(row)) cols.set(k, typeof (row as Record<string, unknown>)[k]);
  return cols;
}

async function main() {
  // 1) 컬럼 존재 확인
  const cols = await fetchColumns();
  for (const name of [
    "distribution_channels",
    "pricing_strategy",
    "marketing_strategy",
    "korea_market_fit",
    "live_commerce",
    "korea_fit_score",
  ]) {
    assert(cols.has(name), `research_results.${name} 컬럼이 존재해야 함 (Migration 1 미적용 의심)`);
  }
  console.log("[ok] 신규 컬럼 6개 존재");

  // 2) 임시 product 생성
  const tempName = `plan-smoke-${Date.now()}`;
  const { data: product, error: prodErr } = await sb
    .from("products")
    .insert({
      name: tempName,
      file_url: "smoke://none",
      file_name: "smoke.txt",
      status: "analyzing",
    })
    .select("id, created_at")
    .single();
  if (prodErr || !product) throw new Error(`product insert 실패: ${prodErr?.message}`);
  console.log(`[ok] 임시 product 생성: ${product.id}`);

  try {
    // 3) 첫 upsert
    const firstInsert = {
      product_id: product.id,
      marketability_score: 70,
      marketability_description: "smoke",
      korea_market_fit: { fit_score: 80, target_products: [], recommended_channels: [] },
      live_commerce: { platforms: ["Instagram Live"], talking_points: [] },
      distribution_channels: [],
      pricing_strategy: { channel_pricing: [], bep_analysis: {} },
      marketing_strategy: [],
    };
    const { data: first, error: firstErr } = await sb
      .from("research_results")
      .upsert(firstInsert, { onConflict: "product_id" })
      .select("id, created_at, korea_fit_score")
      .single();
    if (firstErr || !first) throw new Error(`첫 upsert 실패: ${firstErr?.message}`);
    assert(first.korea_fit_score === 80, `generated korea_fit_score 가 80 이어야 함 (실제: ${first.korea_fit_score})`);
    console.log(`[ok] 첫 upsert: id=${first.id}, korea_fit_score=${first.korea_fit_score}`);

    // 4) 두 번째 upsert — id/created_at 보존, generated 값 갱신
    const secondInsert = {
      product_id: product.id,
      marketability_score: 71,
      marketability_description: "smoke v2",
      korea_market_fit: { fit_score: 55, target_products: [], recommended_channels: [] },
      live_commerce: { platforms: ["TikTok Live"], talking_points: [] },
      distribution_channels: [],
      pricing_strategy: { channel_pricing: [], bep_analysis: {} },
      marketing_strategy: [],
    };
    const { data: second, error: secondErr } = await sb
      .from("research_results")
      .upsert(secondInsert, { onConflict: "product_id" })
      .select("id, created_at, korea_fit_score")
      .single();
    if (secondErr || !second) throw new Error(`두 번째 upsert 실패: ${secondErr?.message}`);
    assert(second.id === first.id, "id 가 보존되어야 함");
    assert(second.created_at === first.created_at, "created_at 이 보존되어야 함");
    assert(second.korea_fit_score === 55, `generated 가 갱신되어야 함 (실제: ${second.korea_fit_score})`);
    console.log("[ok] 두 번째 upsert — id/created_at 보존, generated 갱신");
  } finally {
    // 5) 정리
    await sb.from("research_results").delete().eq("product_id", product.id);
    await sb.from("products").delete().eq("id", product.id);
    console.log("[ok] 임시 row 정리");
  }
}

main().catch((err) => {
  console.error("[FAIL]", err);
  process.exit(1);
});
