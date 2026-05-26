/**
 * 単位テスト: researchOutputSchema が Gemini SDK の Schema 型として
 *   受け入れ可能か、required フィールドが ResearchOutput と一致しているか。
 * 実行: npm run test:research-schema-shape
 */
import { researchOutputSchema } from "../lib/gemini/research-schema";
import { SchemaType } from "@google/generative-ai";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function main(): void {
  // 1) Root is OBJECT
  assert(researchOutputSchema.type === SchemaType.OBJECT, "root.type should be OBJECT");

  // 2) properties has all required research keys
  const props = (researchOutputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  const expected = [
    "marketability_score", "marketability_description", "demographics", "seasonality",
    "cogs_estimate", "influencers", "content_ideas", "competitor_analysis",
    "recommended_price_range", "broadcast_scripts", "japan_export_fit_score",
    "distribution_channels", "pricing_strategy", "marketing_strategy",
    "korea_market_fit", "live_commerce",
  ];
  for (const key of expected) {
    assert(key in props, `properties missing key: ${key}`);
  }

  // 3) required = expected (same length, same values)
  const required = (researchOutputSchema as { required?: string[] }).required ?? [];
  assert(required.length === expected.length, `required length mismatch (got ${required.length}, expected ${expected.length})`);
  for (const key of expected) {
    assert(required.includes(key), `required missing: ${key}`);
  }

  // 4) marketability_score is integer with 0..100 bounds
  const m = props.marketability_score as { type?: SchemaType; minimum?: number; maximum?: number };
  assert(m.type === SchemaType.INTEGER, "marketability_score type should be INTEGER");
  assert(m.minimum === 0 && m.maximum === 100, "marketability_score bounds should be [0,100]");

  // 5) korea_market_fit.properties.fit_score nested check
  const k = props.korea_market_fit as { properties?: { fit_score?: { type?: SchemaType; minimum?: number; maximum?: number } } };
  assert(k.properties?.fit_score?.type === SchemaType.INTEGER, "korea_market_fit.fit_score type should be INTEGER");
  assert(k.properties.fit_score.minimum === 0 && k.properties.fit_score.maximum === 100, "korea_market_fit.fit_score bounds should be [0,100]");

  // 6) influencers is ARRAY with minItems/maxItems
  const inf = props.influencers as { type?: SchemaType; minItems?: number; maxItems?: number };
  assert(inf.type === SchemaType.ARRAY, "influencers type should be ARRAY");
  assert(typeof inf.minItems === "number" && typeof inf.maxItems === "number", "influencers should have minItems and maxItems");

  console.log("[ok] researchOutputSchema shape 検証通過 (16 required keys, nested bounds OK)");
}

main();
