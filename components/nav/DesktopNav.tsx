'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Archive,
  BarChart3,
  BookOpenCheck,
  Boxes,
  CalendarDays,
  ChartNoAxesCombined,
  ClipboardCheck,
  Compass,
  FileSearch,
  FileText,
  GalleryHorizontalEnd,
  Gauge,
  LibraryBig,
  ListChecks,
  PackageSearch,
  Radar,
  RadioTower,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { localePath } from '@/lib/i18n/locale-path';
import {
  NAV_GROUPS,
  findActiveGroup,
  findActiveMember,
  visibleMembersForRole,
} from '@/lib/nav/groups';
import type { Role } from '@/lib/auth/route-permissions';

interface Props {
  role: Role;
  locale: string;
  memberBadges?: Record<string, number>;
}

const GROUP_ICONS: Record<string, LucideIcon> = {
  firm: BarChart3,
  market: Radar,
  produce: RadioTower,
  admin: Wrench,
};

const MEMBER_ICONS: Record<string, LucideIcon> = {
  '/analytics/overview': Gauge,
  '/analytics/products': Boxes,
  '/gallery': GalleryHorizontalEnd,
  '/broadcasts': CalendarDays,
  '/analytics/discovery': Compass,
  '/analytics/strategy': ChartNoAxesCombined,
  '/analytics/pipeline': ListChecks,
  '/screenplays': FileText,
  '/research': FileSearch,
  '/admin/users': Users,
  '/admin/historical-crawl': Radar,
  '/admin/archive-status': Archive,
  '/admin/discovery-calibration': SlidersHorizontal,
  '/admin/research-pipeline': Gauge,
  '/admin/compliance-rules': ShieldCheck,
  '/admin/compliance-references': LibraryBig,
  '/admin/registry': Sparkles,
  '/admin/preferences': Settings2,
};

function NavigationLink({
  href,
  label,
  icon: Icon,
  active,
  badge,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      prefetch
      aria-current={active ? 'page' : undefined}
      aria-label={badge && badge > 0 ? `${label} (${badge})` : label}
      title={label}
      className={`mw-nav-link group relative flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors ${
        active
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground/65 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground'
      }`}
    >
      {active && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" />}
      <Icon size={15} className={`mw-nav-icon ${active ? 'text-primary' : 'text-sidebar-foreground/45 group-hover:text-sidebar-foreground/75'}`} />
      <span className="mw-nav-copy min-w-0 flex-1 truncate">{label}</span>
      {Boolean(badge && badge > 0) && (
        <span className="mw-nav-badge min-w-5 rounded-full bg-primary/12 px-1.5 py-0.5 text-center font-mono text-[10px] font-semibold tabular-nums text-primary">
          {badge}
        </span>
      )}
    </Link>
  );
}

export default function DesktopNav({ role, locale, memberBadges }: Props) {
  const pathname = usePathname();
  const t = useTranslations();
  const activeGroup = findActiveGroup(pathname);

  return (
    <nav aria-label="Primary navigation" className="mw-desktop-nav mw-scrollbar flex-1 space-y-5 overflow-y-auto px-3 py-4">
      {NAV_GROUPS.map((group) => {
        const visibility = group.visibility[role];
        const members = visibleMembersForRole(group, role);
        if (visibility === 'hidden' || (visibility === 'full' && members.length === 0)) return null;
        const GroupIcon = GROUP_ICONS[group.key] ?? PackageSearch;
        const visibleMembers = visibility === 'productsOnly'
          ? group.members.filter((member) => member.href === '/analytics/products')
          : members;

        return (
          <section key={group.key} aria-labelledby={`nav-group-${group.key}`} aria-label={t(group.labelKey)} className="mw-nav-section">
            <div className="mw-nav-group-header mb-1.5 flex items-center gap-2 px-2.5" title={t(group.labelKey)}>
              <GroupIcon size={12} className={activeGroup?.key === group.key ? 'text-primary' : 'text-sidebar-foreground/35'} />
              <h2 id={`nav-group-${group.key}`} className="mw-nav-copy font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/65">
                {t(group.labelKey)}
              </h2>
            </div>
            <div className="space-y-0.5">
              {visibleMembers.map((member) => {
                const active = findActiveMember(group, pathname)?.href === member.href;
                const Icon = MEMBER_ICONS[member.href] ?? ClipboardCheck;
                return (
                  <NavigationLink
                    key={member.href}
                    href={localePath(locale, member.href)}
                    label={t(member.labelKey)}
                    icon={Icon}
                    active={active}
                    badge={memberBadges?.[member.href]}
                  />
                );
              })}
            </div>
          </section>
        );
      })}

      <section aria-labelledby="nav-group-support" aria-label="Support" className="mw-nav-section">
        <div className="mw-nav-group-header mb-1.5 flex items-center gap-2 px-2.5" title="Support">
          <BookOpenCheck size={12} className="text-sidebar-foreground/35" />
          <h2 id="nav-group-support" className="mw-nav-copy font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/65">
            Support
          </h2>
        </div>
        <NavigationLink
          href={localePath(locale, '/guide')}
          label={t('nav.guide')}
          icon={BookOpenCheck}
          active={pathname === '/guide' || pathname.endsWith('/guide')}
        />
      </section>
    </nav>
  );
}
