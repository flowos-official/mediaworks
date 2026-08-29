import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync("supabase/migrations/20260829131000_intelligence_snapshots_runs.sql", "utf8").toLowerCase();
for (const table of ["insight_snapshots", "knowledge_snapshots", "knowledge_snapshot_items", "data_pipeline_runs", "import_batches", "import_rows"]) {
  assert.ok(sql.includes(`create table ${table}`), `missing ${table}`);
}
assert.ok(sql.includes("mode in ('stored_only','supplemented')"));
assert.ok(sql.includes("status in ('queued','running','succeeded','partial','failed')"));
assert.ok(sql.includes("num_nonnulls(evidence_item_id, insight_snapshot_id) = 1"));
console.log("PASS: intelligence snapshot schema");
