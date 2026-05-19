-- 2026-05-19: widen broadcasts.video_status check constraint to include all
-- values used by the video-archival pipeline: queued, downloading, archived,
-- deferred, failed_unsupported, abandoned (in addition to existing pending/failed).

BEGIN;

ALTER TABLE broadcasts
  DROP CONSTRAINT IF EXISTS broadcasts_video_status_check;

ALTER TABLE broadcasts
  ADD CONSTRAINT broadcasts_video_status_check
  CHECK (video_status IN (
    'pending',
    'queued',
    'downloading',
    'archived',
    'deferred',
    'failed_unsupported',
    'abandoned',
    'failed'
  ));

COMMIT;
