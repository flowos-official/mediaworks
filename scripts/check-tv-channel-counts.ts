import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

(async () => {
  const { data, error, count } = await sb
    .from("discovered_products")
    .select("tv_channel_source", { count: "exact" })
    .not("tv_channel_source", "is", null);
  if (error) { console.error(error); return; }
  const counts: Record<string, number> = {};
  for (const r of data ?? []) {
    const src = (r as { tv_channel_source: string }).tv_channel_source;
    for (const slug of src.split(",")) counts[slug] = (counts[slug] ?? 0) + 1;
  }
  console.log("total rows w/ tv_channel_source:", count, "(returned", data?.length ?? 0, ")");
  console.table(counts);
})();
