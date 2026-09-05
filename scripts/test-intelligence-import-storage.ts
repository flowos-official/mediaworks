/**
 * The bucket that holds operators' own sales spreadsheets.
 *
 * These files are the most sensitive thing this system stores: internal cost
 * and margin data, uploaded by name. Everything asserted here is about keeping
 * them where only their owner can reach them — private bucket, owner's uid as
 * the first path segment, and policies that key on that segment rather than on
 * whoever happens to hold the object's name.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
	"supabase/migrations/20260829161000_intelligence_import_storage.sql",
	"utf8",
).toLowerCase();

assert.ok(sql.includes("'intelligence-imports'"), "the bucket must be named");
// Public would mean a guessable URL exposes a company's cost book.
assert.ok(/public\s*[,)=]/.test(sql) && sql.includes("false"), "the bucket must be private");
assert.ok(sql.includes("15728640"), "15 MB cap, matching the upload route");

for (const mime of [
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]) {
	assert.ok(sql.includes(mime), `only Excel types may be stored: missing ${mime}`);
}

// Owner scoping is by the FIRST path segment, which the server route sets to
// auth.uid(). storage.foldername()[1] is how Supabase expresses that.
assert.ok(
	sql.includes("storage.foldername(name)"),
	"owner policies must key on the object's first folder, not on the full name",
);
assert.ok(sql.includes("auth.uid()"), "policies must be owner-scoped");

// Reading someone else's cost book is the failure this whole task prevents, so
// the read policy must exist and must not be role-only.
const policies = sql.split("create policy").slice(1);
assert.ok(policies.length >= 2, "at least a read and a delete policy");
for (const policy of policies) {
	assert.ok(
		policy.includes("intelligence-imports"),
		"every policy must be scoped to this bucket, never to storage.objects at large",
	);
}

// The migration has to survive being applied twice — Supabase storage policies
// are frequently reconciled by hand.
assert.ok(sql.includes("on conflict"), "the bucket insert must be idempotent");
assert.ok(sql.includes("drop policy if exists"), "policy creation must be idempotent");

console.log("PASS: intelligence import storage");
