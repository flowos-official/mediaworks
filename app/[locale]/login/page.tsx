'use client';

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { createBrowserClient } from '@supabase/ssr';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Database, RadioTower, ShieldCheck } from 'lucide-react';
import { ROLE_LANDING, type Role } from '@/lib/auth/route-permissions';
import { localePath } from '@/lib/i18n/locale-path';
import { appConfig } from '@/config/app';

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
      const code = (error as { code?: string }).code;
      const unconfirmed = code === 'email_not_confirmed' || error.message === 'Email not confirmed';
      setErr(unconfirmed ? t('errors.emailNotConfirmed') : t('errors.invalid'));
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
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-6 lg:p-8">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-2xl border border-border bg-card shadow-xl lg:grid-cols-[1.05fr_0.95fr]">
        <section className="hidden border-r border-border bg-muted/30 p-8 lg:flex lg:flex-col lg:justify-between">
          <div>
            <div className="mw-kicker mb-3">{appConfig.copy.loginKicker}</div>
            <h2 className="max-w-md text-3xl font-bold tracking-[-0.04em] text-foreground">
              {appConfig.copy.loginHeadline}
            </h2>
            <p className="mt-4 max-w-lg text-sm leading-7 text-muted-foreground">
              {appConfig.copy.loginDescription}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { icon: Database, label: 'Grounded data' },
              { icon: RadioTower, label: 'Broadcast ops' },
              { icon: ShieldCheck, label: 'Compliance' },
            ].map(({ icon: Icon, label }) => (
              <div key={label} className="rounded-xl border border-border bg-background p-3">
                <Icon size={16} className="text-primary" />
                <div className="mt-2 font-mono text-[9px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>
        </section>
        <Card className="w-full space-y-5 rounded-none border-0 p-6 shadow-none sm:p-8 lg:p-10">
          <div>
            <div className="mw-kicker mb-1">Secure access</div>
            <h1 className="text-xl font-bold tracking-[-0.02em]">{t('title')}</h1>
            <p className="mt-1 text-xs text-muted-foreground">{appConfig.copy.loginWorkspaceLabel}</p>
          </div>
        <form onSubmit={onSubmit} className="space-y-3" aria-busy={loading}>
          <div>
            <label htmlFor="login-email" className="block text-sm mb-1">{t('email')}</label>
            <input
              id="login-email"
              type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-11 w-full rounded-lg border border-border bg-background px-3"
              autoComplete="email"
            />
          </div>
          <div>
            <label htmlFor="login-password" className="block text-sm mb-1">{t('password')}</label>
            <input
              id="login-password"
              type="password" required value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="h-11 w-full rounded-lg border border-border bg-background px-3"
              autoComplete="current-password"
            />
          </div>
          {err && <p role="alert" className="text-sm text-red-600">{err}</p>}
          <Button type="submit" disabled={loading} className="h-11 w-full">
            {t('submit')}
          </Button>
        </form>
        <p className="text-sm text-center">
            <a href={localePath(locale, '/reset-password')} className="text-primary hover:underline">
            {t('forgot')}
          </a>
        </p>
        </Card>
      </div>
    </main>
  );
}
