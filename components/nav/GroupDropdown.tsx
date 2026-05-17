// components/nav/GroupDropdown.tsx
'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { localePath } from '@/lib/i18n/locale-path';
import { findActiveGroup, type NavGroup } from '@/lib/nav/groups';
import type { Role } from '@/lib/auth/route-permissions';

interface Props {
  group: NavGroup;
  role: Role;
  locale: string;
}

export default function GroupDropdown({ group, role, locale }: Props) {
  const pathname = usePathname();
  const visibility = group.visibility[role];
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  if (visibility === 'hidden') return null;

  const isActive = findActiveGroup(pathname)?.key === group.key;
  const t = useTranslations();

  // 'productsOnly': render single direct link, no dropdown UI
  if (visibility === 'productsOnly') {
    return (
      <Link
        href={localePath(locale, '/analytics/products')}
        className={`text-sm font-medium ${
          isActive ? 'text-blue-600' : 'text-gray-600 hover:text-gray-900'
        }`}
      >
        {t('nav.firm.products')}
      </Link>
    );
  }

  // 'full': dropdown
  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <Link
        href={localePath(locale, group.landing)}
        aria-expanded={open}
        aria-haspopup="menu"
        onFocus={() => setOpen(true)}
        className={`inline-flex items-center gap-1 text-sm font-medium ${
          isActive
            ? 'text-blue-600 border-b-2 border-blue-600 -mb-px'
            : 'text-gray-600 hover:text-gray-900'
        }`}
      >
        {t(group.labelKey)}
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </Link>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 min-w-[180px] bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50"
        >
          {group.members.map((m) => (
            <Link
              key={m.href}
              role="menuitem"
              href={localePath(locale, m.href)}
              className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 hover:text-gray-900"
              onClick={() => setOpen(false)}
            >
              {t(m.labelKey)}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
