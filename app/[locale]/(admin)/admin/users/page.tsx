import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
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

  const t = await getTranslations('admin.users');
  return (
    <div className="max-w-5xl mx-auto p-6 space-y-4">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <UsersTable initial={users ?? []} currentUserId={user.id} />
    </div>
  );
}
