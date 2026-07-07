-- 2026-07-07: record how each screenplay was created, for list-view distinction.
-- upload = PDF/Excel/image extract, url = product page URL, import = Word draft,
-- product = generated from an existing researched product. NULL = pre-feature rows.
BEGIN;

ALTER TABLE screenplays
  ADD COLUMN IF NOT EXISTS source_kind text
    CHECK (source_kind IN ('upload','url','import','product'));

COMMENT ON COLUMN screenplays.source_kind IS
  'How the screenplay was created: upload|url|import|product. NULL for rows predating the feature.';

COMMIT;
