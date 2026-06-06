import { timingSafeEqual } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { reconcileArchiveCoverage } from "@/lib/broadcasts/archive-reconciliation";

export const maxDuration = 120;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function verifyCronAuth(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.NODE_ENV !== "production"; // dev-only shortcut; fails closed in prod
  return safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const result = await reconcileArchiveCoverage();
    console.log("[archive-reconciliation]", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[archive-reconciliation] failed:", msg);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
