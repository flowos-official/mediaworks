-- Clear score_breakdown rows that were written on the pre-PR#34 scale.
--
-- Before PR #34 the Gemini prompt allowed review_signal up to 35 and
-- tv_category_match up to 20. PR #34 rescaled those to 0-25 and 0-30
-- respectively (with the total still 100, capping historical-data
-- contribution at 40%). The UI in components/discovery/ProductCard.tsx
-- now renders bars against the new SCORE_MAX (25/30), so any legacy
-- row whose review_signal exceeds 25 would render a nonsensical
-- "32/25" label.
--
-- Strategy: clear `score_breakdown` for the affected rows. The
-- discovery candidate pool is rolling (60-day lookback in
-- lib/strategy/pool-query.ts), so impacted rows will either be
-- re-scored when their session is re-run or naturally rotate out.
-- tvFitScore itself is left untouched; only the per-signal breakdown
-- is dropped so the "内訳" toggle hides gracefully.
--
-- Detection: any row with review_signal > 25 is definitely legacy
-- because the new prompt caps review_signal at 25. This is a strict
-- subset — rows whose legacy review_signal happened to be <=25 are
-- left alone and will display roughly-correct proportions.

UPDATE discovered_products
SET score_breakdown = NULL
WHERE score_breakdown IS NOT NULL
  AND (score_breakdown->>'review_signal')::int > 25;
