import { NextResponse } from "next/server";
import { hasInternalSecret } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { detectStuck } from "@/lib/research/stuck-detector";

export const maxDuration = 30;

export async function GET(req: Request): Promise<NextResponse> {
  if (!hasInternalSecret(req)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const result = await detectStuck(getServiceClient());
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/research-stuck-detector] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
