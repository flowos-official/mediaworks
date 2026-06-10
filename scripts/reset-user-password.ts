/**
 * Reset an existing Supabase Auth user's password via the Admin API.
 *
 * Usage:
 *   tsx --env-file=.env.local scripts/reset-user-password.ts <email> <new-password>
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.
 */

import { createClient } from '@supabase/supabase-js';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const [email, newPassword] = process.argv.slice(2);
  if (!email || !newPassword) {
    throw new Error('Usage: reset-user-password.ts <email> <new-password>');
  }

  const sb = createClient(need('NEXT_PUBLIC_SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // listUsers is paginated (default 50/page); walk pages until we find the email.
  let userId: string | undefined;
  for (let page = 1; !userId; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (match) userId = match.id;
    if (data.users.length < 200) break; // last page
  }

  if (!userId) throw new Error(`No user found with email ${email}`);

  const { error: updErr } = await sb.auth.admin.updateUserById(userId, {
    password: newPassword,
  });
  if (updErr) throw new Error(`updateUserById failed: ${updErr.message}`);

  console.log(`✓ Password updated for ${email} (id=${userId})`);
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
