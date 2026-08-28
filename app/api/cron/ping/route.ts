import { NextResponse } from "next/server";
import { invocationOrigin } from "@/lib/cron/duplicate-guard";

/**
 * Heartbeat for the cron scheduler itself. Writes nothing and reads nothing —
 * its only job is to put one log line per invocation in front of us.
 *
 * Every scheduled job here ran twice per trigger for weeks, and the second
 * caller could not be named because Vercel's cron API is unavailable on this
 * plan and runtime logs are kept about an hour. Waiting for the 23:30 job to
 * find out cost a day per attempt. A five-minute probe answers the same
 * question — how many invocations arrive per tick, and from which build — in
 * one coffee break.
 *
 * Unauthenticated on purpose: a 401 would hide an invocation, and counting
 * invocations is the entire point. It exposes nothing.
 */
export async function GET() {
	console.log(`[cron ping] ${new Date().toISOString()} origin=${invocationOrigin()}`);
	return NextResponse.json({ ok: true, origin: invocationOrigin(), at: new Date().toISOString() });
}
