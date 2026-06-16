-- Version-diff AI rationale cache. Written success-only by
-- GET /api/screenplays/[id]/versions/[versionId]/changes; shape = ChangeNotes
-- ({ ok, key, rationale, computedAt }). No RLS change: screenplay_versions is
-- already gated and the route reads/writes via the service client.
alter table screenplay_versions
  add column if not exists change_notes jsonb;
