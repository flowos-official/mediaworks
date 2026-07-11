'use client';

import { useRouter } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import { useTranslations } from 'next-intl';
import { UserCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { Role } from '@/lib/auth/route-permissions';
import { localePath } from '@/lib/i18n/locale-path';

export default function UserMenu({
  email,
  role,
  locale,
  triggerId,
}: {
  email: string | null;
  role: Role | null;
  locale: string;
  triggerId: string;
}) {
  const router = useRouter();
  const t = useTranslations('auth');

  if (!email || !role) {
    return (
      <a
        href={localePath(locale, '/login')}
        className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300"
      >
        {t('login.submit')}
      </a>
    );
  }

  async function logout() {
    const sb = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    await sb.auth.signOut();
    router.replace(localePath(locale, '/login'));
    router.refresh();
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        id={triggerId}
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`${email} account menu`}
            title={email}
            className={triggerId.includes('desktop') ? 'mw-account-trigger h-9 w-full justify-start gap-2 px-2' : 'gap-2'}
          />
        }
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <UserCircle2 className="h-3.5 w-3.5" />
        </span>
        <span className="mw-account-email hidden min-w-0 flex-1 truncate text-left text-xs sm:inline">{email}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 p-1.5">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span className="text-sm font-medium truncate">{email}</span>
          <Badge variant="outline" className="text-xs ml-2">
            {t(`roleBadge.${role}`)}
          </Badge>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={logout}>{t('logout')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
