-- What a screenplay was generated FROM, recorded before it is generated.
--
-- Until now a version carried its markdown, its model, and — if the feature
-- happened to be enabled and the category happened to be on the whitelist — a
-- pattern_snapshot. Everything else the generator consumed was ephemeral. A
-- reader six weeks later cannot tell whether a script cited a real price or a
-- plausible one, nor whether the absent competitor pattern meant "no such
-- category", "too few samples", or "the lookup timed out". Those are different
-- facts and they were all stored as null.
--
-- A generation context is the answer to "what did this run read". It is
-- written BEFORE prose generation, so a failed generation is still
-- diagnosable, and it is immutable: a refine reuses its base context's
-- evidence rather than re-reading a world that has moved on.
--
-- pattern_status enumerates every way the pattern can be absent. That is the
-- point of the column: `disabled` and `failed` are our side, `no_category` /
-- `off_whitelist` / `under_sampled` are the corpus, `timed_out` is the lookup.
-- Collapsing them to null is what made this undiagnosable before.

BEGIN;

CREATE TABLE screenplay_generation_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  screenplay_id uuid NOT NULL REFERENCES screenplays(id) ON DELETE CASCADE,
  run_id text NOT NULL,
  knowledge_snapshot_id uuid NOT NULL REFERENCES knowledge_snapshots(id) ON DELETE RESTRICT,
  product_fact_pack jsonb NOT NULL,
  reference_broadcasts jsonb NOT NULL DEFAULT '[]'::jsonb,
  pattern_status text NOT NULL CHECK (pattern_status in ('disabled','no_category','off_whitelist','under_sampled','timed_out','failed','applied')),
  pattern_detail text,
  pattern_snapshot jsonb,
  outline jsonb NOT NULL,
  demo_plan jsonb NOT NULL,
  model_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (screenplay_id, run_id)
);

-- Nullable, and it stays nullable: every version generated before this
-- migration is legitimately context-free, and the UI must say "unavailable"
-- rather than invent an empty applied state for them.
ALTER TABLE screenplay_versions
  ADD COLUMN generation_context_id uuid REFERENCES screenplay_generation_contexts(id) ON DELETE RESTRICT;

CREATE TABLE screenplay_claim_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL REFERENCES screenplay_versions(id) ON DELETE CASCADE,
  line_start integer NOT NULL CHECK (line_start > 0),
  line_end integer NOT NULL CHECK (line_end >= line_start),
  claim_text text NOT NULL,
  status text NOT NULL CHECK (status in ('supported','source_claim','needs_review')),
  evidence_item_id uuid REFERENCES evidence_items(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A biconditional, not two one-way checks: a supported claim without
  -- evidence is a lie, and a needs_review claim WITH evidence is a claim
  -- somebody forgot to promote.
  CHECK ((status = 'needs_review') = (evidence_item_id IS NULL))
);

CREATE INDEX screenplay_context_screenplay_idx ON screenplay_generation_contexts(screenplay_id, created_at DESC);
CREATE INDEX screenplay_claim_links_version_idx ON screenplay_claim_links(version_id, line_start);

ALTER TABLE screenplay_generation_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE screenplay_claim_links ENABLE ROW LEVEL SECURITY;

-- Read: member|admin, the grade of every source these rows derive from —
-- screenplays, evidence_items, knowledge_snapshots, broadcast_speech_analyses.
-- The plan sketched `EXISTS (SELECT 1 FROM screenplays ...)`, which reaches the
-- same place today only because RLS nests: it would silently widen the moment
-- screenplays did. 20260830100000 exists because that is exactly what happened
-- once already, so the grade is stated here rather than inherited by accident.
--
-- Write: nothing. The workflow is the only writer and it runs as service-role.
-- These rows are the account of what a script was built from; a user who could
-- edit them could edit the account.
CREATE POLICY screenplay_generation_contexts_read ON screenplay_generation_contexts
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

CREATE POLICY screenplay_claim_links_read ON screenplay_claim_links
  FOR SELECT TO authenticated
  USING (public.current_user_role() IN ('member','admin'));

NOTIFY pgrst, 'reload schema';

COMMIT;
