import { redirect } from 'next/navigation';
import { getServerClient } from '@/lib/supabase/server';
import UsersTable from './UsersTable';
import { localePath } from '@/lib/i18n/locale-path';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage(props: { params: Promise<{ locale: string }> }) {
  const { locale } = await props.params;
  const sb = await getServerClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect(localePath(locale, '/login'));
  const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (profile?.role !== 'admin') redirect(localePath(locale));

  const { data: users } = await sb
    .from('profiles')
    .select('id, email, role, created_at')
    .order('created_at', { ascending: false });

  return (
    <UsersTable initial={users ?? []} currentUserId={user.id} />
  );
}
