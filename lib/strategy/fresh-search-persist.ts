import "server-only";
import { getServiceClient } from "@/lib/supabase";
import { normalizeName } from "@/lib/discovery/exclusion";

export type FreshSearchCandidate = {
  name: string;
  source: "rakuten" | "brave" | "tv_channel" | "web" | "other";
  source_url: string;
  estimated_price_jpy?: string;
  tv_channel_source?: string | null;
  pool_source?: "discovery_pool" | "fresh_search" | "seed" | "research";
  discovered_product_id?: string;
};

export interface PersistResult {
  /** Map of source_url -> discovered_products.id created or re-used. */
  idByUrl: Map<string, string>;
  /** Synthetic discovery_runs.id created for this strategy invocation. */
  sessionId: string;
}

const SOURCE_TO_DP_SOURCE: Record<string, string> = {
  rakuten: "rakuten",
  brave: "brave",
  tv_channel: "tv_channel",
  web: "brave",
  other: "other",
};

function parsePriceJpy(input: string | undefined | null): number | null {
  if (!input) return null;
  const digits = String(input).replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

export async function persistStrategyFreshSearch(
  items: FreshSearchCandidate[],
  opts: { strategyId: string; context: "home_shopping" | "live_commerce" },
): Promise<PersistResult> {
  const targets = items.filter(
    (p) =>
      !p.discovered_product_id &&
      (p.pool_source === "fresh_search" || p.pool_source === "research") &&
      !!p.name &&
      !!p.source_url,
  );

  const idByUrl = new Map<string, string>();
  if (targets.length === 0) {
    return { idByUrl, sessionId: "" };
  }

  const sb = getServiceClient();
  const targetCount = targets.length;

  const { data: session, error: sessErr } = await sb
    .from("discovery_runs")
    .insert({
      status: "completed",
      target_count: targetCount,
      produced_count: targetCount,
      exploration_ratio: 0,
      iterations: 1,
      context: opts.context,
    })
    .select("id")
    .single();

  if (sessErr || !session) {
    throw new Error(
      `[fresh-search-persist] could not create session: ${sessErr?.message}`,
    );
  }

  const seen = new Set<string>();
  const rows = targets
    .filter((p) => {
      if (seen.has(p.source_url)) return false;
      seen.add(p.source_url);
      return true;
    })
    .map((p) => ({
      session_id: session.id,
      name: p.name,
      name_normalized: normalizeName(p.name),
      product_url: p.source_url,
      thumbnail_url: null,
      price_jpy: parsePriceJpy(p.estimated_price_jpy),
      category: null,
      seed_keyword: `strategy:${opts.strategyId}`,
      source: SOURCE_TO_DP_SOURCE[p.source] ?? "other",
      tv_channel_source: p.tv_channel_source ?? null,
      tv_fit_score: 0,
      tv_fit_reason: "Strategy fresh_search rec — score not computed",
      track: "exploration" as const,
      // NOT NULL columns with DB defaults but required for explicit insert
      is_tv_applicable: true,
      is_live_applicable: false,
      context: opts.context,
    }));

  const { data: inserted, error: insErr } = await sb
    .from("discovered_products")
    .insert(rows)
    .select("id, product_url");

  if (insErr) {
    throw new Error(
      `[fresh-search-persist] bulk insert failed: ${insErr.message}`,
    );
  }

  for (const row of inserted ?? []) {
    if (row.product_url) idByUrl.set(row.product_url as string, row.id as string);
  }

  return { idByUrl, sessionId: session.id };
}
