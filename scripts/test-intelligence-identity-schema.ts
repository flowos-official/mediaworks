import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  "supabase/migrations/20260829130000_intelligence_identity_evidence.sql",
  "utf8",
);
for (const token of [
  "create table canonical_products",
  "create table product_source_links",
  "create table evidence_items",
  "evidence_class in ('verified','source_claim','proxy','inferred','internal_input')",
  "value_state in ('known','unknown','not_applicable','stale','conflicting')",
  "unique (source_type, source_table, source_record_id)",
	"canonical_product_id uuid not null references canonical_products(id) on delete restrict",
  "unique (dedupe_key)",
  "enable row level security",
]) assert.ok(sql.toLowerCase().includes(token), `missing: ${token}`);
console.log("PASS: intelligence identity schema");
