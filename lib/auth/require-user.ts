// lib/auth/require-user.ts
import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { getServerClient } from '@/lib/supabase/server';
import type { Role } from './route-permissions';

export type RequireUserResult =
  | { error: NextResponse }
  | { user: User; role: Role; sb: SupabaseClient };

/**
 * Gate an API route on auth + role. Usage:
 *
 *   const auth = await requireUser(['member','admin']);
 *   if ('error' in auth) return auth.error;
 *   // auth.user, auth.role, auth.sb
 */
export async function requireUser(allowed: Role[]): Promise<RequireUserResult> {
  const sb = await getServerClient();
  const { data: { user }, error: userErr } = await sb.auth.getUser();
  if (userErr || !user) {
    return { error: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  }
  const { data: profile } = await sb
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();
  if (!profile || !allowed.includes(profile.role as Role)) {
    return { error: NextResponse.json({ error: 'forbidden' }, { status: 403 }) };
  }
  return { user, role: profile.role as Role, sb };
}

/**
 * Check the internal-task secret used for non-user-initiated server-to-server
 * triggers (analyze -> synthesize, enrich -> worker). Reuses CRON_SECRET to
 * avoid introducing a new env var.
 */
export function hasInternalSecret(req: Pick<Request, 'headers'>): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return timingSafeMatches(req.headers.get('authorization') ?? '', `Bearer ${secret}`);
}

/**
 * Compare in constant time so a wrong header cannot be refined one byte at a
 * time from response timing. Length is compared first because timingSafeEqual
 * throws on a mismatch, and the length of a bearer token is not the secret.
 */
function timingSafeMatches(candidate: string, expected: string): boolean {
  const candidateBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    candidateBytes.length === expectedBytes.length &&
    timingSafeEqual(candidateBytes, expectedBytes)
  );
}
