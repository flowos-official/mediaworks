// lib/supabase/server.ts
import { createServerClient, type CookieMethodsServer } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Server Supabase client that reads/writes the user's session cookies.
 * RLS applies. Use from Server Components, API routes, and Server Actions
 * that act on behalf of a logged-in user.
 *
 * Do NOT use for cron/background jobs — those keep using getServiceClient().
 */
export async function getServerClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies();
  const cookieMethods: CookieMethodsServer = {
    getAll: () => cookieStore.getAll(),
    setAll: (toSet) => {
      for (const { name, value, options } of toSet) {
        try {
          cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; middleware will refresh instead.
        }
      }
    },
  };
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: cookieMethods },
  );
}
