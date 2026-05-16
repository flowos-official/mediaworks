/**
 * Test admin login via Supabase auth. Reads creds from env, never prints them.
 */
import { createClient } from '@supabase/supabase-js';

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const email = 'jp@flowos.work';
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD!;

  if (!password) {
    console.log('No BOOTSTRAP_ADMIN_PASSWORD set');
    process.exit(1);
  }

  console.log(`Testing login for ${email}, pw length=${password.length}`);
  const sb = createClient(url, anonKey);
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    console.log('ERROR:', error.status, error.message);
    process.exit(1);
  }
  console.log('SUCCESS — got session for user:', data.user?.id);
  console.log('access_token length:', data.session?.access_token?.length);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
