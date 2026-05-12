-- Phase A: broadcasts calendar — Shop Channel + QVC Japan

DO $$ BEGIN
  CREATE TYPE broadcast_channel AS ENUM ('shopch', 'qvc');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS broadcasts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         broadcast_channel NOT NULL,
  air_date        date NOT NULL,
  start_time      time NOT NULL,
  program_title   text NOT NULL,
  presenter       text,
  description     text,
  thumbnail_url   text,
  source_url      text NOT NULL,
  scraped_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT broadcasts_slot_unique UNIQUE (channel, air_date, start_time)
);

CREATE INDEX IF NOT EXISTS broadcasts_air_date_idx
  ON broadcasts (air_date DESC);
CREATE INDEX IF NOT EXISTS broadcasts_channel_date_idx
  ON broadcasts (channel, air_date DESC);

CREATE OR REPLACE FUNCTION broadcasts_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS broadcasts_updated_at_trg ON broadcasts;
CREATE TRIGGER broadcasts_updated_at_trg
  BEFORE UPDATE ON broadcasts
  FOR EACH ROW EXECUTE FUNCTION broadcasts_set_updated_at();
