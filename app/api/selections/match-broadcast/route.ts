import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";

export const maxDuration = 5;

function tokenize(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[\s　【】\[\]（）()「」『』・,．.、。!?！？]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

function similarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

export async function GET(req: NextRequest) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;

  const url = new URL(req.url);
  const productName = url.searchParams.get("productName") ?? "";
  const channel = url.searchParams.get("channel");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (!productName)
    return NextResponse.json({ error: "productName required" }, { status: 400 });

  const sb = auth.sb;
  let q = sb
    .from("broadcasts")
    .select("id, channel, air_date, start_time, program_title")
    .order("air_date", { ascending: true })
    .limit(80);

  if (channel && channel !== "all") q = q.eq("channel", channel);
  if (from) q = q.gte("air_date", from);
  if (to) q = q.lte("air_date", to);

  const { data, error } = await q;
  if (error) {
    console.error("[selections/match-broadcast] query failed", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const ranked = (data ?? [])
    .map((row) => ({ ...row, score: similarity(productName, row.program_title) }))
    .sort((a, b) => b.score - a.score);

  return NextResponse.json({
    suggestions: ranked.filter((r) => r.score > 0.15).slice(0, 6),
    others: ranked.filter((r) => r.score <= 0.15).slice(0, 30),
  });
}
