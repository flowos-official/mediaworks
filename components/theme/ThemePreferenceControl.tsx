'use client';

import { useSyncExternalStore } from 'react';
import { useTheme } from 'next-themes';
import { useTranslations } from 'next-intl';
import { Monitor, Moon, Sun } from 'lucide-react';

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

export default function ThemePreferenceControl() {
  const { theme, setTheme, systemTheme } = useTheme();
  const t = useTranslations('theme');
  const mounted = useMounted();
  const current = mounted ? theme ?? 'system' : 'system';
  const systemSuffix =
    mounted && systemTheme === 'dark' ? t('systemSuffixDark') : mounted ? t('systemSuffixLight') : '';
  const options = [
    { value: 'light', label: t('light'), icon: Sun },
    { value: 'dark', label: t('dark'), icon: Moon },
    { value: 'system', label: systemSuffix ? `${t('system')} (${systemSuffix})` : t('system'), icon: Monitor },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const Icon = option.icon;
        const active = current === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => setTheme(option.value)}
            className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-border bg-background text-foreground hover:border-blue-300 hover:text-blue-600'
            }`}
          >
            <Icon className="h-4 w-4" />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
