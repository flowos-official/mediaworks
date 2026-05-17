# Discovery Category Normalization — Design

**Status**: Approved brainstorm, ready for implementation plan
**Date**: 2026-05-17
**Scope**: Fix the category vocabulary gap discovered in production after `tv-evidence-mining` (PR #46) shipped — `discovered_products.category` (Rakuten-genre strings like `"自動 豆乳 メーカー"`) does not lexically overlap with `broadcasts.category` (curated whitelist labels like `"家電"`), producing ~0% evidence match rate.

---

## 1. Problem statement

`tv-evidence-mining` uses `splitCategoryToKeywords` to compute keyword intersection between candidate and broadcast categories. This works only when both sides share a vocabulary. In production:

- `discovered_products.category` — comes from Rakuten Item Search genre field; free-form Japanese, often multi-word with whitespace (e.g. `"自動 豆乳 メーカー"`, `"コードレス 掃除機 強力吸引"`).
- `broadcasts.category` — for shopch + qvc, drawn from a user-curated whitelist (`channel_categories` table) like `"家電"`, `"コスメ"`, `"ホーム・インテリア"`. After policy change 2026-05-17, non-whitelist categories are also persisted but considered noise / long-tail for matching purposes.
- `historical_broadcasts.category` — null for all 8 OA channels (no whitelist configured yet).

Result: zero keyword overlap for typical cases, `tv_evidence` is null for nearly every candidate, score bonus and report grounding never trigger.

## 2. Goal

Introduce a deterministic `raw_category → whitelist_categories[]` mapping layer. The first time a Rakuten-genre string is seen, classify it via Gemini against the union of channel whitelist labels; persist the result; serve all future lookups from the cache.

Replace `splitCategoryToKeywords(candidate.category)` keyword matching in `fetchMatchingBroadcastRows` with `normalizeCategory(candidate.category)` whitelist lookup, then match `WHERE broadcasts.category IN (...whitelist)` (exact, index-friendly).

## 3. Non-goals

- ML model fine-tuning — Gemini Flash is sufficient and follows the existing `lib/broadcasts/shopch-category.ts` pattern.
- Admin UI for editing classifications — admin edits the cache table directly via Supabase dashboard for v1. UI is v2.
- Auto re-classification on whitelist change — manual `TRUNCATE` + re-run backfill is acceptable. Whitelist changes are rare and admin-initiated.
- Per-channel separate normalization — we use the union of shopch + qvc whitelists. If a candidate maps to `"家電"` and shopch+qvc both have `"家電"` rows, both will match — that's the right behavior.
- Normalization of `historical_broadcasts.category` — currently null. Out of scope until those channels get their own whitelist.
- Removing the existing `splitCategoryToKeywords` helper — it is still used by `competitor-trend-boost.ts` for the reverse direction (broadcast hot category → candidate name/category substring match). Leave it.

## 4. Schema — new table `discovered_category_normalization`

```sql
CREATE TABLE discovered_category_normalization (
  raw_category         text PRIMARY KEY,
  whitelist_categories text[] NOT NULL,                      -- 0..3 elements; empty array = "no whitelist match"
  source               text NOT NULL CHECK (source IN ('gemini','manual')),
  classified_at        timestamptz NOT NULL DEFAULT now(),
  notes                text                                  -- admin notes on manual overrides
);

CREATE INDEX idx_dcn_classified_at ON discovered_category_normalization (classified_at DESC);
```

- Empty-array results are cached intentionally — prevents re-classifying known-no-match categories.
- `source='manual'` rows are protected from cron overwrite (Gemini-classifier upserts use `ON CONFLICT DO NOTHING` when `source='manual'`; see §6).
- RLS: Group B (member/admin read, admin write). Cron uses service role.

## 5. Module — `lib/discovery/category-normalize.ts`

```ts
export async function normalizeCategory(
  sb: SupabaseClient,
  rawCategory: string | null
): Promise<string[]>;
// Cache hit → return whitelist_categories.
// Cache miss → Gemini single-item classify → upsert → return.
// Empty/null input → return [].
// Gemini error → log + return [], do NOT cache the failure.

export async function normalizeCategoriesBatch(
  sb: SupabaseClient,
  rawCategories: string[]
): Promise<Map<string, string[]>>;
// Dedup input → look up cached → batch-classify the misses (50 per Gemini call) → upsert → return map.
// Used by backfill script + refresh-tv-evidence cron.
```

Gemini prompt shape (mirroring `lib/broadcasts/shopch-category.ts`):

```
日本の家庭用通販商品のカテゴリ文字列を、以下のホワイトリストに分類してください。
複数該当する場合は最大3つ、該当無しは空配列を返してください。

【ホワイトリスト — このうちから正確にコピー】
- ビューティー
- コスメ
- 美容・ダイエット・フィットネス
- 健康・ダイエット
- 靴・バッグ・小物・インナー
- ファッション小物
- ホーム
- ホーム・インテリア
- キッチングッズ
- レジャー・ホビー
- 家電

【入力】
[0] 自動 豆乳 メーカー
[1] コードレス 掃除機 強力吸引
...

【出力 — JSONのみ】
{ "results": [
  {"index": 0, "matches": ["キッチングッズ", "家電"]},
  {"index": 1, "matches": ["家電"]}
]}
```

Whitelist is read from `channel_categories` table at module init (cached for the process lifetime). Hallucinated outputs not in the whitelist are silently dropped.

## 6. Integration into `tv-evidence.ts`

Replace the category-matching path in `fetchMatchingBroadcastRows`:

```ts
// Before
const categoryKeywords = splitCategoryToKeywords(candidate.category ?? "");
if (categoryKeywords.length === 0) return [];
// ...filter rows in-process by keyword intersection...

// After
const whitelistCategories = await normalizeCategory(sb, candidate.category);
if (whitelistCategories.length === 0) return [];

const bRes = await sb
  .from("broadcasts")
  .select(...)
  .gte("air_date", cutoff)
  .in("category", whitelistCategories);   // DB pushdown, index-friendly

const hRes = await sb
  .from("historical_broadcasts")
  .select(...)
  .gte("air_date", cutoff)
  .in("category", whitelistCategories);   // future-ready; today returns 0 since historical category is null
```

The match_basis in the resulting `TvEvidence.match_basis.category_keywords` now stores the **whitelist categories used** (not the raw keywords) — same field, more useful information for downstream prompts. The field is internal to the `tv_evidence` jsonb shape; no external consumer (UI badge, strategy prompt) reads it directly, so this semantic shift is safe.

**Corroboration rule preserved**: the existing "category AND (price-band OR name-token OR no-corroboration-available)" second filter remains. Whitelist category match alone is necessary but not sufficient — e.g. both a vacuum cleaner and a soy milk maker fall under `"家電"`, but only the price/name corroboration confirms they are comparable. Whitelist exact-match is much stricter than the prior keyword intersection, so corroboration false-positives drop; the rule itself does not change.

## 7. Backfill — `scripts/backfill-category-normalization.ts`

```
1. SELECT DISTINCT category FROM discovered_products WHERE category IS NOT NULL;
2. Subtract already-cached raw_categories.
3. For the rest, call normalizeCategoriesBatch in chunks of 50.
4. Log how many were classified, how many got non-empty matches.
5. npm alias: `npm run backfill:category-normalize`.
```

Expected size: ~500 distinct categories at most, ~10 Gemini calls, ~$0.001 total. One-shot.

After backfill, manually trigger the `refresh-tv-evidence` cron to recompute evidence with the new matching path.

## 8. Cron interaction

`refresh-tv-evidence` cron (already exists, weekly Sunday 17:30 UTC):
- Per candidate, calls `computeTvEvidence` → `fetchMatchingBroadcastRows` → calls `normalizeCategory` internally.
- Cache-miss penalty per cron run: at most one Gemini call per new raw_category. After backfill, this should be near-zero on subsequent runs.

`daily-discovery-home` / `daily-discovery-live` crons already integrate evidence (PR #46). With this change, new candidates' first evidence computation will hit the cache (if backfill ran) or lazily classify (if not).

## 9. Failure modes

| Scenario | Behavior |
|---|---|
| Candidate has null/empty category | `normalizeCategory` returns `[]`. evidence = null. Score unchanged. (Same as today.) |
| Cached as empty array (known no-match) | Return `[]` immediately. evidence = null. No Gemini call. |
| Gemini call errors | Log warning, return `[]`, **do NOT cache** (so next call retries). |
| Gemini returns hallucinated category not in whitelist | Silently drop from result, cache the valid subset (may be empty). |
| Whitelist changes (admin adds a new label) | Cached classifications become slightly stale — they won't have the new label. Manual `TRUNCATE discovered_category_normalization WHERE source='gemini'` + re-run backfill. Manual rows preserved. |

## 10. Security & RLS

- `discovered_category_normalization` is Group B (member/admin only). Cron uses service role bypass.
- Whitelist data is read from `channel_categories` table — same RLS already in place.
- No new user-facing surface in v1 (no API, no UI).

## 11. Performance

- Cache hit: <5ms (PK lookup).
- Cache miss + single-item Gemini classify: ~500-1500ms.
- Batch classify (50): ~1500-3000ms, ~$0.0001 per call.
- Storage: ~500 rows × 200 bytes = negligible.

## 12. Test plan

**Unit (no DB, no Gemini):**
- `parseGeminiResponse(text)` — verify parsed `{ results: [{index, matches[]}] }` shape; reject hallucinated labels.
- `validateAgainstWhitelist(matches, whitelist)` — filter helper.

**Integration (real Supabase + real Gemini, gated on env vars):**
- Pick 5 known raw categories from `discovered_products`, normalize each, assert non-empty whitelist or explicit empty (for genuinely unmatched).
- Re-normalize the same 5 → assert cache hit (no new Gemini call detectable via classified_at timestamp unchanged).
- Round-trip through `fetchMatchingBroadcastRows` → assert non-zero match count for candidates whose normalized category overlaps with QVC/ShopCh broadcasts.

**npm scripts:**
- `npm run test:category-normalize-unit`
- `npm run test:category-normalize-integration`
- `npm run test:category-normalize` (composite)

## 13. Migration / rollout

1. Apply migration creating `discovered_category_normalization` table.
2. Deploy code: `lib/discovery/category-normalize.ts` + `tv-evidence.ts` patch + cron path unchanged + backfill script + tests.
3. Run backfill script once: `npm run backfill:category-normalize` (against staging first, then prod).
4. Manually trigger `refresh-tv-evidence` cron to recompute evidence.
5. Spot-check 5 products via `npm run check:tv-evidence -- <id>` — confirm evidence is now non-null for products in supported categories.

Rollback: revert `fetchMatchingBroadcastRows` to use `splitCategoryToKeywords`; keep the table and module in place. No data loss.

## 14. Spec deviations from earlier plans

None — this is a fresh design. The earlier `tv-evidence-mining` spec acknowledged this as a known follow-up.

## 15. Out of scope (explicit YAGNI carve-outs)

- Admin UI for cache row editing
- Auto-detection of new whitelist categories (cron polls `channel_categories` for changes)
- Confidence scores per classification (Gemini doesn't reliably expose them in JSON mode; not worth the parsing complexity for v1)
- Multi-language category support (current data is Japanese only; English categories from international sources would need separate handling, not currently a use case)
- Reverse mapping (whitelist → potential raw categories) — not needed for tv_evidence
