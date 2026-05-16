/**
 * Demote/promote a user via service role (bypasses RLS + trigger).
 * Usage: tsx scripts/set-role.ts <email> <admin|member|viewer>
 */
import { createClient } from '@supabase/supabase-js';

async function main() {
  const email = process.argv[2];
  const role = process.argv[3];
  if (!email || !['admin', 'member', 'viewer'].includes(role)) {
    console.error('usage: tsx scripts/set-role.ts <email> <admin|member|viewer>');
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await sb
    .from('profiles')
    .update({ role })
    .eq('email', email)
    .select('id, email, role')
    .maybeSingle();
  if (error) {
    console.error('FAILED:', error.message);
    process.exit(1);
  }
  console.log('OK:', data);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
