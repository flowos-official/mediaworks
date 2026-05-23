'use client';

import { useTheme } from 'next-themes';
import { useSyncExternalStore } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

let mountedSnapshot = false;
const subscribeMounted = (onStoreChange: () => void) => {
  const id = window.setTimeout(() => {
    mountedSnapshot = true;
    onStoreChange();
  }, 0);
  return () => window.clearTimeout(id);
};
const getClientMountedSnapshot = () => mountedSnapshot;
const getServerMountedSnapshot = () => false;

function useMounted() {
  return useSyncExternalStore(
    subscribeMounted,
    getClientMountedSnapshot,
    getServerMountedSnapshot,
  );
}

function ThemeOptions() {
  const { theme, setTheme, systemTheme } = useTheme();
  const t = useTranslations('theme');
  const mounted = useMounted();

  // Avoid hydration mismatch: render a stable label until mounted.
  const systemSuffix =
    mounted && systemTheme === 'dark' ? t('systemSuffixDark') : mounted ? t('systemSuffixLight') : '';

  return (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground">
        {t('label')}
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={mounted ? theme ?? 'system' : 'system'}
        onValueChange={(value) => setTheme(value)}
      >
        <DropdownMenuRadioItem value="light">
          <Sun className="mr-2 h-4 w-4" />
          {t('light')}
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="dark">
          <Moon className="mr-2 h-4 w-4" />
          {t('dark')}
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="system">
          <Monitor className="mr-2 h-4 w-4" />
          {t('system')}
          {systemSuffix && (
            <span className="ml-2 text-xs text-muted-foreground">({systemSuffix})</span>
          )}
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </>
  );
}

export function ThemeMenu() {
  const { theme, systemTheme } = useTheme();
  const t = useTranslations('theme');
  const mounted = useMounted();
  const resolvedTheme = mounted ? theme ?? 'system' : 'system';
  const Icon =
    !mounted
      ? Monitor
      : resolvedTheme === 'light'
      ? Sun
      : resolvedTheme === 'dark'
        ? Moon
        : systemTheme === 'dark'
          ? Moon
          : Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('label')}
            title={t('label')}
          />
        }
      >
        <Icon className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <ThemeOptions />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
