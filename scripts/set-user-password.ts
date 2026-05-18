/**
 * Create or update a Supabase user via Admin SDK — bypasses email verification
 * entirely. If the user doesn't exist, creates them with the given password and
 * role. If they exist, updates the password and (optionally) the role.
 *
 * Usage:
 *   tsx scripts/set-user-password.ts <email> [password] [--role=admin|member|viewer]
 *
 * Examples:
 *   tsx scripts/set-user-password.ts user@example.com
 *     → creates/updates with auto-generated 16-char password, role=member
 *   tsx scripts/set-user-password.ts user@example.com MyPass123 --role=admin
 *     → creates/updates with given password, role=admin
 */
import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'crypto';

type Role = 'admin' | 'member' | 'viewer';

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

function parseArgs(): { email: string; password: string; role: Role } {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));

  const emailArg = positional[0];
  if (!emailArg) {
    console.error('usage: tsx scripts/set-user-password.ts <email> [password] [--role=admin|member|viewer]');
    process.exit(1);
  }

  const roleFlag = flags.find((f) => f.startsWith('--role='));
  const role = (roleFlag?.split('=')[1] ?? 'member') as Role;
  if (!['admin', 'member', 'viewer'].includes(role)) {
    console.error(`invalid role: ${role}. must be admin|member|viewer`);
    process.exit(1);
  }

  return {
    email: emailArg.toLowerCase(),
    password: positional[1] ?? generatePassword(),
    role,
  };
}

async function main(): Promise<void> {
  const { email, password, role } = parseArgs();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: list } = await sb.auth.admin.listUsers();
  const existing = list.users.find((u) => u.email?.toLowerCase() === email);

  let userId: string;
  let action: 'created' | 'updated';

  if (existing) {
    userId = existing.id;
    const { error: updErr } = await sb.auth.admin.updateUserById(userId, {
      password,
      email_confirm: true,
    });
    if (updErr) throw new Error(`updateUserById failed: ${updErr.message}`);
    action = 'updated';
  } else {
    const { data, error } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error || !data.user) {
      throw new Error(`createUser failed: ${error?.message ?? 'no user returned'}`);
    }
    userId = data.user.id;
    action = 'created';
  }

  // The handle_new_user trigger sets role='viewer' by default; override here.
  const { error: roleErr } = await sb
    .from('profiles')
    .update({ role })
    .eq('id', userId);
  if (roleErr) throw new Error(`role update failed: ${roleErr.message}`);

  const { data: profile } = await sb
    .from('profiles')
    .select('id, email, role')
    .eq('id', userId)
    .single();

  console.log(`\n[set-user-password] ${action} — credentials below:`);
  console.log(`  email:    ${profile?.email}`);
  console.log(`  password: ${password}`);
  console.log(`  role:     ${profile?.role}`);
  console.log(`  login at: https://mediaworks-six.vercel.app/ja/login\n`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
