'use client';

import { useEffect, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { localePath } from '@/lib/i18n/locale-path';

type Mode = 'request' | 'confirm';

export default function ResetPasswordPage() {
  const t = useTranslations('auth.resetPassword');
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<Mode>('request');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.hash.includes('type=recovery')) {
      setMode('confirm');
    }
  }, [params]);

  const sb = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  async function requestReset(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const redirectTo = `${window.location.origin}${localePath(locale, '/reset-password')}`;
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) { setErr(error.message); return; }
    setDone(t('requestSent'));
  }

  async function confirmReset(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const { error } = await sb.auth.updateUser({ password });
    if (error) { setErr(error.message); return; }
    setDone(t('confirmDone'));
    setTimeout(() => router.replace(localePath(locale, '/login')), 1500);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <Card className="w-full max-w-md p-8 space-y-4">
        <h1 className="text-xl font-bold">
          {mode === 'request' ? t('requestTitle') : t('confirmTitle')}
        </h1>
        {mode === 'request' ? (
          <form onSubmit={requestReset} className="space-y-3">
            <input
              type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border rounded px-3 py-2"
              autoComplete="email"
            />
            <Button type="submit" className="w-full">{t('requestSubmit')}</Button>
          </form>
        ) : (
          <form onSubmit={confirmReset} className="space-y-3">
            <input
              type="password" required value={password} minLength={8}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border rounded px-3 py-2"
              autoComplete="new-password"
              placeholder={t('newPassword')}
            />
            <Button type="submit" className="w-full">{t('confirmSubmit')}</Button>
          </form>
        )}
        {err && <p className="text-sm text-red-600">{err}</p>}
        {done && <p className="text-sm text-green-700">{done}</p>}
      </Card>
    </div>
  );
}
