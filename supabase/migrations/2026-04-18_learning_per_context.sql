-- Phase 4: split learning_state per context

-- Step 1: add context column as nullable
ALTER TABLE learning_state
  ADD COLUMN IF NOT EXISTS context text
    CHECK (context IN ('home_shopping', 'live_commerce'));

-- Step 2: assign existing row(s) to home_shopping
UPDATE learning_state SET context = 'home_shopping' WHERE context IS NULL;

-- Step 3: make context NOT NULL
ALTER TABLE learning_state ALTER COLUMN context SET NOT NULL;

-- Step 4: drop old PK + id column + CHECK (id = 1) constraint
ALTER TABLE learning_state DROP CONSTRAINT IF EXISTS learning_state_pkey;
ALTER TABLE learning_state DROP CONSTRAINT IF EXISTS learning_state_id_check;
ALTER TABLE learning_state DROP COLUMN IF EXISTS id;

-- Step 5: add new PK on context
ALTER TABLE learning_state ADD PRIMARY KEY (context);

-- Step 6: insert live_commerce row if not exists
INSERT INTO learning_state (context)
  VALUES ('live_commerce')
  ON CONFLICT (context) DO NOTHING;
