'use client';

import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

export function ThemeSubmenu() {
  const { theme, setTheme, systemTheme } = useTheme();
  const t = useTranslations('theme');
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Avoid hydration mismatch: render a stable label until mounted.
  const systemSuffix =
    mounted && systemTheme === 'dark' ? t('systemSuffixDark') : mounted ? t('systemSuffixLight') : '';

  return (
    <>
      <DropdownMenuSeparator />
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
