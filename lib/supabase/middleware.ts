// lib/supabase/middleware.ts
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextRequest, NextResponse } from 'next/server';

type Role = 'admin' | 'member' | 'viewer';
type SupabaseCookieToSet = { name: string; value: string; options?: CookieOptions };

export interface SessionInfo {
  response: NextResponse;
  user: { id: string; email: string | undefined } | null;
  role: Role | null;
  mustChangePassword: boolean;
}

/**
 * Reads the request's session cookies, refreshes them if needed, and returns:
 *  - response: NextResponse with refreshed cookies attached (always use this)
 *  - user:    null if unauthenticated, else { id, email }
 *  - role:    null if unauthenticated, else 'admin' | 'member' | 'viewer'
 */
export async function updateSession(req: NextRequest): Promise<SessionInfo> {
  let response = NextResponse.next({ request: req });
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (toSet: SupabaseCookieToSet[]) => {
          for (const { name, value } of toSet) {
            req.cookies.set(name, value);
          }
          response = NextResponse.next({ request: req });
          for (const { name, value, options } of toSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { data: { user } } = await sb.auth.getUser();
  if (!user) return { response, user: null, role: null, mustChangePassword: false };

  const { data: profile } = await sb
    .from('profiles')
    .select('role, must_change_password')
    .eq('id', user.id)
    .maybeSingle();

  const role = (profile?.role ?? null) as Role | null;
  const mustChangePassword = Boolean(profile?.must_change_password);
  return { response, user: { id: user.id, email: user.email }, role, mustChangePassword };
}
