/**
 * Invite a list of emails as members. Skips emails that already exist as admin
 * (to avoid demoting). New invites send an email with a password-setup link.
 *
 * Usage: tsx scripts/invite-members.ts <email> [<email> ...]
 */
import { createClient } from '@supabase/supabase-js';

type Role = 'admin' | 'member' | 'viewer';

interface Outcome {
  email: string;
  status: 'invited' | 'already-member' | 'already-admin-kept' | 'promoted' | 'error';
  detail?: string;
}

async function main(): Promise<void> {
  const emails = process.argv.slice(2);
  if (emails.length === 0) {
    console.error('usage: tsx scripts/invite-members.ts <email> [<email> ...]');
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const sb = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const outcomes: Outcome[] = [];

  for (const email of emails) {
    try {
      // Check if user exists by listing
      const { data: list } = await sb.auth.admin.listUsers();
      const existing = list.users.find((u) => u.email === email);

      if (existing) {
        // Look at profile.role
        const { data: profile } = await sb
          .from('profiles')
          .select('role')
          .eq('id', existing.id)
          .maybeSingle();
        const role = (profile?.role ?? 'viewer') as Role;

        if (role === 'admin') {
          outcomes.push({ email, status: 'already-admin-kept' });
          continue;
        }
        if (role === 'member') {
          outcomes.push({ email, status: 'already-member' });
          continue;
        }
        // Existing user with viewer role -> promote to member
        const { error: upErr } = await sb
          .from('profiles').update({ role: 'member' }).eq('id', existing.id);
        if (upErr) {
          outcomes.push({ email, status: 'error', detail: `promote: ${upErr.message}` });
        } else {
          outcomes.push({ email, status: 'promoted' });
        }
        continue;
      }

      // New user — send invite
      const { data, error } = await sb.auth.admin.inviteUserByEmail(email);
      if (error || !data.user) {
        outcomes.push({ email, status: 'error', detail: error?.message ?? 'no user returned' });
        continue;
      }

      // The handle_new_user trigger has created a profile with role='viewer'.
      // Promote to member.
      const { error: upErr } = await sb
        .from('profiles').update({ role: 'member' }).eq('id', data.user.id);
      if (upErr) {
        outcomes.push({ email, status: 'error', detail: `promote: ${upErr.message}` });
      } else {
        outcomes.push({ email, status: 'invited' });
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      outcomes.push({ email, status: 'error', detail: msg });
    }
  }

  console.log('\nResults:');
  console.table(outcomes);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
