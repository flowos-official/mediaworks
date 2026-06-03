# テレ東マート (txd) Discovery Exclusion — Design

**Status**: Approved brainstorm, ready for implementation plan
**Date**: 2026-06-02
**Scope**: Stop テレ東マート (`txd`) products from appearing in product search — both new intake (Brave site: fan-out) and already-saved rows — across the discovery board (`/discovery/home`) and the strategy expansion pool (`md-strategy`). Operator feedback: "原則的にテレ東の商品は検索に出ないようにしてほしい."

---

## 1. Goal

`txd` (slug for tv-tokyoshop.jp, registered as a discovery TV channel in `lib/discovery/tv-channels.ts`) is currently sourced via Brave `site:tv-tokyoshop.jp` search and persisted onto `discovered_products.tv_channel_source`. The operator wants these products excluded from search by default. After this change:

- No new `txd` candidates enter the pool (Brave fan-out skips it).
- Existing `txd`-tagged rows are hidden from the discovery board AND the strategy expansion pool.

This is a **complete removal** (decided during brainstorm), not a UI toggle.

## 2. Non-Goals

- **No deletion of historical rows.** Existing `txd` rows stay in `discovered_products` (audit/history); they are filtered at read time, not purged.
- **No change to the broadcast calendar.** `txd` as an OA channel in `historical_broadcasts` / the calendar (`lib/broadcasts/channel-style.ts`) is a *separate* registry and is unaffected — see the two-registry note in CLAUDE.md. This spec touches only the *discovery* registry (`lib/discovery/tv-channels.ts`).
- **No generalized per-channel allow/block UI.** We add a single reusable exclusion mechanism keyed on slug, seeded with `txd`. An admin-facing channel toggle UI is future work.

## 3. Root-Cause / Current State (verified)

| Layer | File | Current behavior |
|---|---|---|
| New intake | `lib/discovery/pool.ts:209-274` `fetchTvChannelFromBraveSite()` | iterates `channels.filter(c => !c.scraped)` (13 channels incl. `txd`), fires `${keyword} site:tv-tokyoshop.jp`, tags results `tvChannel:"txd"` |
| Persist | `lib/discovery/save.ts:157-189` | writes `tv_channel_source` as a comma-joined slug string, e.g. `"japanet,txd"` |
| Discovery read | `/api/discovery/today` + `lib/discovery/cached.ts` | no channel exclusion |
| Strategy pool read | `lib/strategy/pool-query.ts:85-145` `queryDiscoveredPool` / `applyFilters` | no channel exclusion |
| Promote-to-tier-0 | `lib/discovery/orchestrator.ts:218` `partitionByTier` | any `tvChannelSource` presence promotes to tier 0 — excluding txd at intake correctly prevents promotion |

`tv_channel_source` is a comma-joined string. The codebase already uses a **word-boundary regex** for slug matching in `lib/discovery/channel-taste.ts:89` — reuse that approach to avoid `%txd%` substring false positives (e.g. a hypothetical `txdx`).

## 4. Design

### 4.1 Exclusion registry (single source of truth)

Add to `lib/discovery/tv-channels.ts`:

```ts
// Channels whose products must not surface in discovery/strategy search.
// Calendar visibility (lib/broadcasts) is unaffected — separate registry.
export const EXCLUDED_DISCOVERY_SLUGS: ReadonlySet<string> = new Set(["txd"]);
```

A shared helper (same file or `lib/discovery/channel-taste.ts`) for read-time filtering:

```ts
// True if a comma-joined tv_channel_source contains any excluded slug as a token.
export function hasExcludedChannel(tvChannelSource: string | null): boolean {
  if (!tvChannelSource) return false;
  return [...EXCLUDED_DISCOVERY_SLUGS].some((slug) =>
    new RegExp(`(^|,)${slug}(,|$)`).test(tvChannelSource));
}
```

### 4.2 Block new intake — `lib/discovery/pool.ts`

In `fetchTvChannelFromBraveSite()`, change the target filter:

```ts
const targets = channels.filter(
  (c) => !c.scraped && !EXCLUDED_DISCOVERY_SLUGS.has(c.slug),
);
```

→ Brave never queries `site:tv-tokyoshop.jp` again. No txd candidates created. Tier-0 promotion (`partitionByTier`) is consequently never reached by txd.

### 4.3 Defense-in-depth at persist — `lib/discovery/save.ts`

Before insert, drop any candidate whose only/any channel signal is excluded (covers any path that still produces a txd candidate, e.g. a future re-enabled scrape). Match on the candidate's `tvChannel` field and/or product URL host `tv-tokyoshop.jp`. Skipped candidates are `log()`-ed (no silent drop).

### 4.4 Retroactive hide — read queries

Two read paths must suppress already-saved txd rows. PostgREST cannot do word-boundary regex on a text column cleanly, so the chosen pattern is: fetch candidate rows, then filter in JS with `hasExcludedChannel()` before returning. Volume is small (board/pool are already capped), so the cost is negligible.

- `lib/strategy/pool-query.ts::queryDiscoveredPool` — apply `hasExcludedChannel` filter after the DB fetch, before scoring/return. Note: this reduces the pool count, so it must run **before** the `fail-open if < 5 results` fallback logic (an all-txd pool should fall back to fresh search, not surface txd).
- `/api/discovery/today` + `lib/discovery/cached.ts` — same JS filter on the returned rows. Keep the cache key unchanged; filtering is post-fetch and deterministic.

Alternative considered: a PostgREST `.not("tv_channel_source", "ilike", "%,txd,%")` guard. Rejected as primary because it misses edge tokens (leading/trailing `txd` without surrounding commas) and risks substring false positives. May be added as a coarse pre-filter to reduce rows fetched, with the JS pass as the precise gate.

## 5. Tests

`scripts/test-txd-exclusion.ts` (`npm run test:txd-exclusion`), unit-level (no live DB needed for the matcher):

| `tv_channel_source` | `hasExcludedChannel` |
|---|---|
| `"txd"` | true |
| `"japanet,txd"` | true |
| `"txd,japanet"` | true |
| `"japanet"` | false |
| `"txdx"` | false (no false positive) |
| `null` | false |

Plus an assertion that `fetchTvChannelFromBraveSite`'s target list excludes `txd` (import the registry, filter, assert absence).

## 6. Edge Cases & Failure Modes

| Scenario | Behavior |
|---|---|
| Product aired on both japanet and txd (`"japanet,txd"`) | Hidden. Acceptable: txd and japanet have different product URLs/domains, so URL-dedup keeps them as separate rows in practice; a genuine multi-channel merge is rare and exclusion is the operator's stated intent. |
| All discovery-pool results are txd | `hasExcludedChannel` filter empties the pool → existing fresh-search fallback in `pool-query.ts` kicks in. Must verify filter runs before the `< 5` fallback. |
| Future re-enable of txd scraping | Remove `txd` from `EXCLUDED_DISCOVERY_SLUGS`; both intake and read filters lift automatically. |
| New excluded channel later | Add its slug to the set — one line, no other change. |

## 7. Success Criteria

- `npm run test:txd-exclusion` passes all matcher cases.
- After deploy, a discovery run produces **0** new rows with `tv_channel_source` containing `txd`.
- `/discovery/home` and `/strategy/expansion` show no txd-sourced cards even for rows saved before the change.
- A keyword that previously surfaced tv-tokyoshop.jp items no longer returns them.

## 8. Out-of-Scope Future Work

- Admin UI toggle to manage `EXCLUDED_DISCOVERY_SLUGS` without a deploy.
- One-shot purge of historical txd rows if storage/clarity warrants (currently kept for audit).
