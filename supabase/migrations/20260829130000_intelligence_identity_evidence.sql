create table canonical_products (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(btrim(display_name)) > 0),
  brand text,
  model_name text,
  normalized_category text,
  attributes jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','merged','inactive')),
  merged_into_id uuid references canonical_products(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'merged') = (merged_into_id is not null))
);

create table product_source_links (
  id uuid primary key default gen_random_uuid(),
  canonical_product_id uuid not null references canonical_products(id) on delete restrict,
  source_type text not null check (source_type in ('qvc','shopch','oa','discovery','research','internal_excel')),
  source_table text not null,
  source_record_id text not null,
  source_product_id text,
  raw_name text not null,
  match_method text not null check (match_method in ('exact_id','normalized_key','similarity','manual')),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  confirmed boolean not null default false,
  confirmed_by uuid references profiles(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_type, source_table, source_record_id),
  check (not confirmed or confirmed_at is not null)
);

create table evidence_items (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null check (subject_type in ('product','broadcast','category','internal_product')),
  subject_id text not null,
  predicate text not null,
  value_json jsonb,
  unit text,
  value_state text not null default 'known'
    check (value_state in ('known','unknown','not_applicable','stale','conflicting')),
  evidence_class text not null
    check (evidence_class in ('verified','source_claim','proxy','inferred','internal_input')),
  source_type text not null,
  source_table text not null,
  source_record_id text not null,
  source_url text,
  source_locator text,
  observed_at timestamptz not null,
  valid_from timestamptz,
  valid_until timestamptz,
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  raw_hash text,
  conflict_group text,
  supersedes_id uuid references evidence_items(id) on delete set null,
  dedupe_key text not null,
  created_at timestamptz not null default now(),
  unique (dedupe_key),
  check ((value_state = 'known') = (value_json is not null)),
  check (valid_until is null or valid_from is null or valid_until >= valid_from)
);

create index canonical_products_category_idx on canonical_products(normalized_category) where status = 'active';
create index product_source_links_product_idx on product_source_links(canonical_product_id);
create index evidence_subject_idx on evidence_items(subject_type, subject_id, predicate, observed_at desc);
create index evidence_source_idx on evidence_items(source_type, source_table, source_record_id);
create index evidence_fresh_idx on evidence_items(valid_until) where value_state = 'known';

alter table canonical_products enable row level security;
alter table product_source_links enable row level security;
alter table evidence_items enable row level security;

create policy canonical_products_read on canonical_products for select to authenticated using (true);
create policy product_source_links_read on product_source_links for select to authenticated using (true);
create policy evidence_items_read on evidence_items for select to authenticated using (true);
