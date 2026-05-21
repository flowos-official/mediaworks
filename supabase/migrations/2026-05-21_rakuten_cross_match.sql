-- Add rakuten_cross_match column to discovered_products.
--
-- Stores the Rakuten Item Search result that the cross-match enrichment in
-- lib/discovery/rakuten-crossmatch.ts associated with a TV-channel candidate.
-- Used as a popularity proxy for the 13 non-broadcast TV channels (japanet,
-- ntv, tbs, dinos, ropping, etc.) which don't publish review/sales data.
--
-- NULL when:
--   - candidate is from rakuten/brave (no cross-match needed)
--   - candidate is from QVC/ShopCh (broadcast data already authoritative)
--   - cross-match enrichment was attempted but no high-confidence match found

ALTER TABLE discovered_products
  ADD COLUMN IF NOT EXISTS rakuten_cross_match jsonb;

COMMENT ON COLUMN discovered_products.rakuten_cross_match IS
  'Rakuten cross-match popularity proxy for non-broadcast TV-channel candidates. Shape: { itemUrl, itemName, reviewCount, reviewAvg, priceJpy, similarityScore }. NULL when no match found or not applicable.';
