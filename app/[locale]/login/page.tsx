'use client';

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { createBrowserClient } from '@supabase/ssr';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ROLE_LANDING, type Role } from '@/lib/auth/route-permissions';
import { localePath } from '@/lib/i18n/locale-path';

export default function LoginPage() {
  const t = useTranslations('auth.login');
  const locale = useLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setLoading(true);
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    const { error, data } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      setErr(t('errors.invalid'));
      setLoading(false);
      return;
    }
    const userId = data.user?.id;
    let role: Role = 'viewer';
    if (userId) {
      const { data: profile } = await sb
        .from('profiles').select('role').eq('id', userId).maybeSingle();
      if (profile?.role) role = profile.role as Role;
    }
    // Hard navigation so the Server-Component Navbar re-renders with the new session
    window.location.assign(localePath(locale, ROLE_LANDING[role]));
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <Card className="w-full max-w-md p-8 space-y-4">
        <h1 className="text-xl font-bold">{t('title')}</h1>
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-sm mb-1">{t('email')}</label>
            <input
              type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border rounded px-3 py-2"
              autoComplete="email"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">{t('password')}</label>
            <input
              type="password" required value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border rounded px-3 py-2"
              autoComplete="current-password"
            />
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <Button type="submit" disabled={loading} className="w-full">
            {t('submit')}
          </Button>
        </form>
        <p className="text-sm text-center">
          <a href={localePath(locale, '/reset-password')} className="text-blue-600 hover:underline">
            {t('forgot')}
          </a>
        </p>
      </Card>
    </div>
  );
}
