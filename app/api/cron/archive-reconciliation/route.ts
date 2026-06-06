import { type NextRequest, NextResponse } from "next/server";
import { reconcileArchiveCoverage } from "@/lib/broadcasts/archive-reconciliation";

export const maxDuration = 120;

function verifyCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // dev mode
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const result = await reconcileArchiveCoverage();
    const out = { ...result, duration_ms: Date.now() - startedAt };
    console.log("[archive-reconciliation]", JSON.stringify(out));
    return NextResponse.json(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[archive-reconciliation] failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
