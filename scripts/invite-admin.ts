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
  const emailArg = process.argv[2];
  if (!emailArg) {
    console.error('usage: tsx scripts/invite-admin.ts <email>');
    process.exit(1);
  }
  // Supabase stores emails lowercase; normalize for both invite + lookup so
  // re-runs find the existing user instead of trying to re-invite.
  const email = emailArg.toLowerCase();

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: list } = await sb.auth.admin.listUsers();
  const existing = list.users.find((u) => u.email?.toLowerCase() === email);

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
    console.log(`[invite-admin] ${email} exists with role=${role}, ensuring admin + sending password recovery email`);

    // Original invite links are single-use; if the user lost/consumed it,
    // try to send a recovery email so they can set their password via the
    // reset-password page (which also handles type=recovery).
    const { error: recoverErr } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: REDIRECT_TO,
    });
    if (recoverErr) {
      console.warn(`[invite-admin] recovery email failed: ${recoverErr.message}`);
      // Email blocked (rate limit, SMTP issue, etc.) — fall back to admin-
      // generated recovery link the operator can forward manually.
      const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
        type: 'recovery',
        email,
        options: { redirectTo: REDIRECT_TO },
      });
      if (linkErr || !linkData?.properties?.action_link) {
        console.error(`[invite-admin] generateLink also failed: ${linkErr?.message ?? 'no link'}`);
      } else {
        console.log('\n[invite-admin] manual recovery link (forward to user):');
        console.log(`  ${linkData.properties.action_link}\n`);
      }
    } else {
      console.log(`[invite-admin] recovery email sent (redirectTo=${REDIRECT_TO})`);
    }
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
