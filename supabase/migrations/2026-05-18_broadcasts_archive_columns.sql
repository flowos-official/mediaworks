-- 2026-05-18: document the video-archival columns on `broadcasts`.
--
-- These columns were originally added directly to the production DB (see
-- memory note "Migrations applied manually" — the repo has no supabase CLI /
-- db:push, so schema changes are applied by hand and back-filled here for
-- reproducibility). Without this, a fresh scratch/staging DB lacks the columns
-- the archive pipeline (lib/broadcasts/video-archival.ts, archive-
-- reconciliation.ts, the daily-broadcasts cron) reads & writes, and the
-- 2026-05-19 video_status CHECK migration (which assumes video_status exists)
-- fails. Dated 2026-05-18 so it runs before that CHECK on a clean apply.
--
-- All ADDs are IF NOT EXISTS so this is a no-op on the production DB where the
-- columns already exist. The `broadcasts` base table itself predates the
-- tracked migrations (Broadcast Calendar Phase A); product_ids/category are
-- included defensively for the same reason.

BEGIN;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS video_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS archived_video_s3 text,
  ADD COLUMN IF NOT EXISTS video_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS video_duration_sec integer,
  ADD COLUMN IF NOT EXISTS video_quality text,
  ADD COLUMN IF NOT EXISTS video_downloaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS video_error text,
  ADD COLUMN IF NOT EXISTS video_download_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS brand_name text,
  ADD COLUMN IF NOT EXISTS brand_code text,
  ADD COLUMN IF NOT EXISTS product_ids text[],
  ADD COLUMN IF NOT EXISTS category text;

-- Partial index mirrors the archive cron's hot query (queued, oldest-first).
CREATE INDEX IF NOT EXISTS broadcasts_video_status_queued_idx
  ON broadcasts (air_date)
  WHERE video_status = 'queued';

COMMIT;
