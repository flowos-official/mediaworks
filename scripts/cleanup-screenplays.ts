// Targeted cleanup of the `screenplays` table.
//
// Keeps rows whose title matches a known-real demo (贅沢の極み, ひろがる木陰,
// Nonoji Kabo-chou, plain アイアジャストグラス) and deletes everything else
// (parallel-N, stress-*, STRESS-*, xss-*, <script>...</script> XSS probes,
// validation-test, 手入力テスト商品, テスト商品（進捗確認用), TEST-suffixed
// アイアジャストグラス, empty titles).
//
// Usage:
//   tsx --env-file=.env.local scripts/cleanup-screenplays.ts            # dry run
//   tsx --env-file=.env.local scripts/cleanup-screenplays.ts --apply    # actually delete

import { createClient } from "@supabase/supabase-js";

const APPLY = process.argv.includes("--apply");

function shouldKeep(title: string | null): boolean {
  const t = (title ?? "").trim();
  if (!t) return false;
  if (t.includes("贅沢の極み")) return true;
  if (t.includes("ひろがる木陰")) return true;
  if (t.includes("Nonoji")) return true;
  // Keep an exact-match アイアジャストグラス, but not "STRESS-..." / "... TEST" variants.
  if (t === "アイアジャストグラス") return true;
  return false;
}

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });

  const { data, error } = await sb
    .from("screenplays")
    .select("id, title, status, updated_at")
    .order("updated_at", { ascending: false });
  if (error) { console.error(error.message); process.exit(1); }

  const all = data ?? [];
  const keep = all.filter((r) => shouldKeep(r.title));
  const drop = all.filter((r) => !shouldKeep(r.title));

  console.log(`Mode: ${APPLY ? "APPLY (will delete)" : "DRY RUN (no DB writes)"}`);
  console.log(`Total: ${all.length} · Keep: ${keep.length} · Delete: ${drop.length}\n`);

  console.log("--- KEEP ---");
  for (const r of keep) console.log(`  ${r.id}  ${(r.status ?? "").padEnd(10)}  ${r.title}`);
  console.log("\n--- DELETE ---");
  for (const r of drop) console.log(`  ${r.id}  ${(r.status ?? "").padEnd(10)}  ${(r.title ?? "").slice(0, 80) || "(empty)"}`);

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to execute.");
    return;
  }

  if (drop.length === 0) {
    console.log("\nNothing to delete.");
    return;
  }

  // FK ON DELETE CASCADE in migration handles screenplay_versions cleanup.
  const ids = drop.map((r) => r.id);
  const { error: delErr } = await sb.from("screenplays").delete().in("id", ids);
  if (delErr) { console.error("delete failed:", delErr.message); process.exit(1); }
  console.log(`\nDeleted ${ids.length} row(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
