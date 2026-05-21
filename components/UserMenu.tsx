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
import { ThemeSubmenu } from '@/components/theme/ThemeSubmenu';
import type { Role } from '@/lib/auth/route-permissions';
import { localePath } from '@/lib/i18n/locale-path';

export default function UserMenu({
  email,
  role,
  locale,
}: {
  email: string | null;
  role: Role | null;
  locale: string;
}) {
  const router = useRouter();
  const t = useTranslations('auth');

  if (!email || !role) {
    return (
      <a
        href={localePath(locale, '/login')}
        className="text-sm font-medium text-blue-600 hover:underline"
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
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className="gap-2" />}>
        <UserCircle2 className="h-4 w-4" />
        <span className="hidden sm:inline text-sm">{email}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span className="text-sm font-medium truncate">{email}</span>
          <Badge variant="outline" className="text-xs ml-2">
            {t(`roleBadge.${role}`)}
          </Badge>
        </DropdownMenuLabel>
        <ThemeSubmenu />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={logout}>{t('logout')}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
