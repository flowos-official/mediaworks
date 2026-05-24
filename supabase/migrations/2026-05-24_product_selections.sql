-- Product Selection Pipeline (spec 2026-05-24)
-- Adds product_selections + product_selection_events with RLS and a
-- backfill of existing discovered_products.user_action='sourced' rows.

BEGIN;

CREATE TABLE IF NOT EXISTS product_selections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discovered_product_id uuid NOT NULL REFERENCES discovered_products(id) ON DELETE CASCADE,

  status text NOT NULL DEFAULT 'selected'
    CHECK (status IN ('selected','sourcing','scheduled','closed')),

  owner_id    uuid NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  assignee_id uuid          REFERENCES profiles(id) ON DELETE SET NULL,

  broadcast_id uuid REFERENCES broadcasts(id) ON DELETE SET NULL,

  closed_reason text CHECK (closed_reason IN ('aired','dropped','postponed')),
  closed_at     timestamptz,
  closed_by     uuid REFERENCES profiles(id),

  sourcing_note  text,
  scheduled_note text,
  closed_note    text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT scheduled_requires_anchor
    CHECK (status != 'scheduled'
           OR broadcast_id IS NOT NULL
           OR scheduled_note IS NOT NULL),
  CONSTRAINT closed_requires_reason
    CHECK (status != 'closed'
           OR (closed_reason IS NOT NULL AND closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_selection_per_product
  ON product_selections(discovered_product_id) WHERE status != 'closed';

CREATE INDEX IF NOT EXISTS idx_ps_status_active
  ON product_selections(status, updated_at DESC) WHERE status != 'closed';
CREATE INDEX IF NOT EXISTS idx_ps_owner_active
  ON product_selections(owner_id) WHERE status != 'closed';
CREATE INDEX IF NOT EXISTS idx_ps_assignee_active
  ON product_selections(assignee_id) WHERE status != 'closed';
CREATE INDEX IF NOT EXISTS idx_ps_discovered
  ON product_selections(discovered_product_id);
CREATE INDEX IF NOT EXISTS idx_ps_broadcast
  ON product_selections(broadcast_id) WHERE broadcast_id IS NOT NULL;

CREATE OR REPLACE FUNCTION product_selections_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS product_selections_updated_at_trg ON product_selections;
CREATE TRIGGER product_selections_updated_at_trg
  BEFORE UPDATE ON product_selections
  FOR EACH ROW EXECUTE FUNCTION product_selections_set_updated_at();

CREATE TABLE IF NOT EXISTS product_selection_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  selection_id uuid NOT NULL REFERENCES product_selections(id) ON DELETE CASCADE,

  event_type text NOT NULL CHECK (event_type IN (
    'created',
    'status_changed',
    'assignee_changed',
    'broadcast_linked',
    'broadcast_unlinked',
    'closed',
    'reopened',
    'note_updated'
  )),

  from_status      text,
  to_status        text,
  from_assignee_id uuid REFERENCES profiles(id),
  to_assignee_id   uuid REFERENCES profiles(id),
  broadcast_id     uuid REFERENCES broadcasts(id),
  closed_reason    text,
  note             text,

  actor_id  uuid REFERENCES profiles(id),
  is_system boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pse_selection_time
  ON product_selection_events(selection_id, created_at DESC);

-- RLS
ALTER TABLE product_selections       ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_selection_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ps_select  ON product_selections;
DROP POLICY IF EXISTS ps_write   ON product_selections;
DROP POLICY IF EXISTS pse_select ON product_selection_events;
DROP POLICY IF EXISTS pse_insert ON product_selection_events;

CREATE POLICY ps_select ON product_selections
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ps_write ON product_selections
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p
                 WHERE p.id = auth.uid() AND p.role IN ('member','admin')))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p
                      WHERE p.id = auth.uid() AND p.role IN ('member','admin')));

CREATE POLICY pse_select ON product_selection_events
  FOR SELECT TO authenticated USING (true);

CREATE POLICY pse_insert ON product_selection_events
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p
                      WHERE p.id = auth.uid() AND p.role IN ('member','admin')));

-- Backfill existing sourced rows whose original author is recoverable.
INSERT INTO product_selections (
  discovered_product_id, status, owner_id, created_at, updated_at
)
SELECT
  dp.id,
  'selected',
  (SELECT pf.user_id FROM product_feedback pf
     WHERE pf.discovered_product_id = dp.id AND pf.action = 'sourced'
     ORDER BY pf.created_at DESC LIMIT 1),
  COALESCE(dp.action_at, dp.created_at),
  COALESCE(dp.action_at, dp.created_at)
FROM discovered_products dp
WHERE dp.user_action = 'sourced'
  AND EXISTS (
    SELECT 1 FROM product_feedback pf
    WHERE pf.discovered_product_id = dp.id AND pf.action = 'sourced'
  )
ON CONFLICT DO NOTHING;

INSERT INTO product_selection_events (
  selection_id, event_type, to_status, actor_id, is_system, note
)
SELECT id, 'created', 'selected', owner_id, true,
       'Backfilled from existing discovered_products.user_action=''sourced'''
FROM product_selections
WHERE NOT EXISTS (
  SELECT 1 FROM product_selection_events e
  WHERE e.selection_id = product_selections.id AND e.event_type = 'created'
);

COMMIT;
