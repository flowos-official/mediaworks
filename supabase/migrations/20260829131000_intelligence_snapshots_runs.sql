create table insight_snapshots (
  id uuid primary key default gen_random_uuid(),
  insight_type text not null,
  subject_type text not null,
  subject_id text not null,
  input_from timestamptz,
  input_until timestamptz not null,
  result jsonb not null,
  evidence_count integer not null check (evidence_count >= 0),
  coverage jsonb not null default '{}'::jsonb,
  formula_version text not null,
  model_version text,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  valid_until timestamptz,
  created_at timestamptz not null default now()
);

create table insight_snapshot_evidence (
  insight_snapshot_id uuid not null references insight_snapshots(id) on delete cascade,
  evidence_item_id uuid not null references evidence_items(id) on delete restrict,
  primary key (insight_snapshot_id, evidence_item_id)
);

create table knowledge_snapshots (
  id uuid primary key default gen_random_uuid(),
  consumer_type text not null check (consumer_type in ('product_recommendation','research','screenplay')),
  consumer_run_id text not null,
  created_by uuid references profiles(id) on delete set null,
  mode text not null check (mode in ('stored_only','supplemented')),
  query_json jsonb not null default '{}'::jsonb,
  data_cutoff timestamptz not null,
  algorithm_version text not null,
  model_version text,
  created_at timestamptz not null default now(),
  unique (consumer_type, consumer_run_id)
);

create table knowledge_snapshot_items (
  id uuid primary key default gen_random_uuid(),
  knowledge_snapshot_id uuid not null references knowledge_snapshots(id) on delete cascade,
  evidence_item_id uuid references evidence_items(id) on delete restrict,
  insight_snapshot_id uuid references insight_snapshots(id) on delete restrict,
  usage_role text not null,
  result_locator text,
  created_at timestamptz not null default now(),
  check (num_nonnulls(evidence_item_id, insight_snapshot_id) = 1)
);

create table data_pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  job_type text not null,
  external_run_id text,
  status text not null check (status in ('queued','running','succeeded','partial','failed')),
  cursor_json jsonb,
  target_scope jsonb not null default '{}'::jsonb,
  counts jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_summary text,
  unique (source_type, job_type, external_run_id)
);

create table import_batches (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references profiles(id) on delete restrict,
  file_name text not null,
  storage_path text not null,
  file_sha256 text not null,
  status text not null check (status in ('uploaded','mapped','validated','applied','partial','rolled_back','failed')),
  column_mapping jsonb,
  row_counts jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  raw_json jsonb not null,
  normalized_json jsonb,
  validation_errors jsonb not null default '[]'::jsonb,
  canonical_product_id uuid references canonical_products(id) on delete set null,
  applied_at timestamptz,
  unique (import_batch_id, row_number)
);

create index insight_subject_idx on insight_snapshots(insight_type, subject_type, subject_id, input_until desc);
create index knowledge_consumer_idx on knowledge_snapshots(consumer_type, created_at desc);
create index pipeline_runs_latest_idx on data_pipeline_runs(source_type, job_type, started_at desc);
create index import_batches_owner_idx on import_batches(created_by, created_at desc);

alter table insight_snapshots enable row level security;
alter table insight_snapshot_evidence enable row level security;
alter table knowledge_snapshots enable row level security;
alter table knowledge_snapshot_items enable row level security;
alter table data_pipeline_runs enable row level security;
alter table import_batches enable row level security;
alter table import_rows enable row level security;

create policy insight_snapshots_read on insight_snapshots for select to authenticated using (true);
create policy insight_snapshot_evidence_read on insight_snapshot_evidence for select to authenticated using (true);
create policy knowledge_snapshots_read on knowledge_snapshots for select to authenticated using (created_by = auth.uid());
create policy knowledge_snapshot_items_read on knowledge_snapshot_items for select to authenticated using (
  exists (select 1 from knowledge_snapshots s where s.id = knowledge_snapshot_id and s.created_by = auth.uid())
);
create policy pipeline_runs_read on data_pipeline_runs for select to authenticated using (true);
create policy import_batches_owner_read on import_batches for select to authenticated using (created_by = auth.uid());
create policy import_rows_owner_read on import_rows for select to authenticated using (
  exists (select 1 from import_batches b where b.id = import_batch_id and b.created_by = auth.uid())
);
