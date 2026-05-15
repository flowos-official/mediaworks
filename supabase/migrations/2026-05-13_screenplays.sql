-- supabase/migrations/2026-05-13_screenplays.sql
-- Screenplays + versioned iterations with user feedback.

create table if not exists screenplays (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references products(id) on delete set null,
  title text not null,
  product_info_snapshot jsonb not null,
  current_version_id uuid,
  status text not null default 'pending'
    check (status in ('pending','generating','ready','failed')),
  last_run_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists screenplay_versions (
  id uuid primary key default gen_random_uuid(),
  screenplay_id uuid not null references screenplays(id) on delete cascade,
  version_number int not null,
  markdown text not null,
  feedback text,
  base_version_id uuid references screenplay_versions(id) on delete set null,
  model text not null,
  thinking_level text not null,
  token_usage jsonb,
  created_at timestamptz not null default now(),
  unique (screenplay_id, version_number)
);

alter table screenplays
  add constraint screenplays_current_version_fk
    foreign key (current_version_id)
    references screenplay_versions(id)
    on delete set null;

create index if not exists screenplays_created_at_idx on screenplays(created_at desc);
create index if not exists screenplay_versions_screenplay_id_idx on screenplay_versions(screenplay_id, version_number);
