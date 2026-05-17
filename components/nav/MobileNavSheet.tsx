// components/nav/MobileNavSheet.tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Menu, X } from 'lucide-react';
import { localePath } from '@/lib/i18n/locale-path';
import { NAV_GROUPS } from '@/lib/nav/groups';
import type { Role } from '@/lib/auth/route-permissions';

interface Props {
  role: Role;
  locale: string;
}

export default function MobileNavSheet({ role, locale }: Props) {
  const [open, setOpen] = useState(false);
  const t = useTranslations();

  const groups = NAV_GROUPS.filter((g) => g.visibility[role] !== 'hidden');

  return (
    <>
      <button
        type="button"
        aria-label="Open navigation"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="md:hidden p-2 text-gray-600 hover:text-gray-900"
      >
        <Menu size={20} />
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-white md:hidden">
          <div className="flex items-center justify-between h-16 px-4 border-b border-gray-200">
            <span className="text-lg font-bold text-gray-900">MediaWorks</span>
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setOpen(false)}
              className="p-2 text-gray-600 hover:text-gray-900"
            >
              <X size={20} />
            </button>
          </div>
          <nav className="p-4 space-y-2">
            {groups.map((g) => {
              if (g.visibility[role] === 'productsOnly') {
                return (
                  <Link
                    key={g.key}
                    href={localePath(locale, '/analytics/products')}
                    onClick={() => setOpen(false)}
                    className="block py-3 px-3 text-base font-medium text-gray-900 rounded-lg hover:bg-gray-50"
                  >
                    {t('nav.firm.products')}
                  </Link>
                );
              }
              return (
                <details key={g.key} className="group">
                  <summary className="flex items-center justify-between py-3 px-3 text-base font-semibold text-gray-900 cursor-pointer rounded-lg hover:bg-gray-50">
                    {t(g.labelKey)}
                    <span className="text-gray-400 group-open:rotate-180 transition-transform">▾</span>
                  </summary>
                  <div className="pl-4 space-y-1 pb-2">
                    {g.members.map((m) => (
                      <Link
                        key={m.href}
                        href={localePath(locale, m.href)}
                        onClick={() => setOpen(false)}
                        className="block py-2 px-3 text-sm text-gray-700 rounded-lg hover:bg-gray-50"
                      >
                        {t(m.labelKey)}
                      </Link>
                    ))}
                  </div>
                </details>
              );
            })}
          </nav>
        </div>
      )}
    </>
  );
}
