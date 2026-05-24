/**
 * Smoke for lib/strategy/fresh-search-persist. Hits a real Supabase.
 * Inserts two recs, asserts they get ids back and that a session row was
 * created. Cleans up after itself.
 *
 * Run: npm run test:strategy-fresh-search
 */
import { persistStrategyFreshSearch } from "../lib/strategy/fresh-search-persist";
import { getServiceClient } from "../lib/supabase";

async function main() {
  const strategyId = `smoke-${Date.now()}`;
  const items = [
    {
      name: "Smoke Product A",
      source: "rakuten" as const,
      source_url: `https://example.test/${strategyId}/a`,
      estimated_price_jpy: "¥3,980",
      pool_source: "fresh_search" as const,
    },
    {
      name: "Smoke Product B",
      source: "brave" as const,
      source_url: `https://example.test/${strategyId}/b`,
      pool_source: "research" as const,
    },
    {
      name: "Already linked",
      source: "rakuten" as const,
      source_url: `https://example.test/${strategyId}/c`,
      pool_source: "discovery_pool" as const,
      discovered_product_id: "00000000-0000-0000-0000-000000000000",
    },
  ];

  const res = await persistStrategyFreshSearch(items, {
    strategyId,
    context: "home_shopping",
  });

  let failures = 0;
  function check(cond: boolean, label: string) {
    if (cond) console.log(`PASS: ${label}`);
    else {
      console.error(`FAIL: ${label}`);
      failures++;
    }
  }

  check(res.idByUrl.size === 2, "two new ids returned");
  check(res.idByUrl.has(items[0].source_url), "rec A id is mapped");
  check(res.idByUrl.has(items[1].source_url), "rec B id is mapped");
  check(!!res.sessionId, "synthetic session id returned");

  const sb = getServiceClient();
  if (res.sessionId) {
    await sb.from("discovered_products").delete().eq("session_id", res.sessionId);
    await sb.from("discovery_runs").delete().eq("id", res.sessionId);
  }

  if (failures > 0) {
    console.error(`${failures} assertion(s) failed`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
