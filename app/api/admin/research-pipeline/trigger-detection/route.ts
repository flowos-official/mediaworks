import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { detectStuck } from "@/lib/research/stuck-detector";

export async function POST(): Promise<NextResponse> {
  const auth = await requireUser(["admin"]);
  if ("error" in auth) return auth.error;

  try {
    const result = await detectStuck(getServiceClient());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[admin/trigger-detection] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
