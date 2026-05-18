/**
 * Set a password for an existing Supabase user via Admin SDK. Bypasses the
 * email recovery/invite flow — use when the user can't receive emails or the
 * SMTP rate limit blocks normal recovery.
 *
 * Usage: tsx scripts/set-user-password.ts <email> [password]
 *   If password is omitted, a random 16-char password is generated and printed.
 */
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';

function generatePassword(): string {
  // 16 chars, URL-safe, no ambiguous chars
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

async function main(): Promise<void> {
  const emailArg = process.argv[2];
  if (!emailArg) {
    console.error('usage: tsx scripts/set-user-password.ts <email> [password]');
    process.exit(1);
  }
  const email = emailArg.toLowerCase();
  const password = process.argv[3] ?? generatePassword();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: list } = await sb.auth.admin.listUsers();
  const existing = list.users.find((u) => u.email?.toLowerCase() === email);
  if (!existing) {
    throw new Error(`user not found: ${email}`);
  }

  const { error: updErr } = await sb.auth.admin.updateUserById(existing.id, {
    password,
    email_confirm: true,
  });
  if (updErr) {
    throw new Error(`updateUserById failed: ${updErr.message}`);
  }

  const { data: profile } = await sb
    .from('profiles')
    .select('id, email, role')
    .eq('id', existing.id)
    .single();

  console.log('\n[set-user-password] credentials set:');
  console.log(`  email:    ${profile?.email}`);
  console.log(`  password: ${password}`);
  console.log(`  role:     ${profile?.role}`);
  console.log(`  login at: https://mediaworks-six.vercel.app/ja/login\n`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
