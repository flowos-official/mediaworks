// One-shot cleanup for screenplay rows created by E2E runs.
// Deletes the rows + any version children created earlier today.
import { createClient } from "@supabase/supabase-js";

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: tsx scripts/cleanup-e2e-screenplays.ts <id> [id ...] | --all-e2e");
  process.exit(2);
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  let targetIds: string[] = ids;
  if (ids.includes("--all-e2e")) {
    const { data, error } = await sb
      .from("screenplays")
      .select("id, title")
      .like("title", "[E2E%");
    if (error) throw error;
    targetIds = (data ?? []).map((r) => r.id as string);
    console.log(`Found ${targetIds.length} [E2E ...] rows`);
  }
  if (!targetIds.length) {
    console.log("nothing to delete");
    return;
  }
  // Version rows cascade via FK ON DELETE CASCADE in the migration.
  const { error } = await sb.from("screenplays").delete().in("id", targetIds);
  if (error) throw error;
  console.log(`deleted ${targetIds.length} screenplay(s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
