/**
 * Invite a single email as admin. Skips when already admin. Promotes existing
 * member/viewer to admin without re-sending an invite. New invites send an
 * email with a password-setup link.
 *
 * Usage: tsx scripts/invite-admin.ts <email>
 */
import { createClient } from '@supabase/supabase-js';

type Role = 'admin' | 'member' | 'viewer';

const REDIRECT_TO = 'https://mediaworks-six.vercel.app/ja/reset-password';

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error('usage: tsx scripts/invite-admin.ts <email>');
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: list } = await sb.auth.admin.listUsers();
  const existing = list.users.find((u) => u.email === email);

  let userId: string;
  let invited = false;

  if (existing) {
    userId = existing.id;
    const { data: profile } = await sb
      .from('profiles')
      .select('role')
      .eq('id', userId)
      .maybeSingle();
    const role = (profile?.role ?? 'viewer') as Role;
    if (role === 'admin') {
      console.log(`[invite-admin] ${email} already admin — no-op`);
      return;
    }
    console.log(`[invite-admin] ${email} exists with role=${role}, promoting to admin`);
  } else {
    const { data, error } = await sb.auth.admin.inviteUserByEmail(email, {
      redirectTo: REDIRECT_TO,
    });
    if (error || !data.user) {
      throw new Error(`inviteUserByEmail failed: ${error?.message ?? 'no user returned'}`);
    }
    userId = data.user.id;
    invited = true;
    console.log(`[invite-admin] invite email sent to ${email} (redirectTo=${REDIRECT_TO})`);
  }

  const { error: upErr } = await sb
    .from('profiles')
    .update({ role: 'admin' })
    .eq('id', userId);
  if (upErr) {
    throw new Error(`promote to admin failed: ${upErr.message}`);
  }

  const { data: verified } = await sb
    .from('profiles')
    .select('id, email, role')
    .eq('id', userId)
    .single();
  console.log(`[invite-admin] result:`, { invited, ...verified });
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
