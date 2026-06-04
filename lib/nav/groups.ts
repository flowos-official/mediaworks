// lib/nav/groups.ts
import type { Role } from '@/lib/auth/route-permissions';

export type GroupKey = 'firm' | 'market' | 'produce' | 'admin';

export interface NavMember {
  /** next-intl translation key, e.g. 'nav.firm.overview' */
  labelKey: string;
  /** Locale-agnostic path; pass through localePath() at render time. */
  href: string;
}

export type GroupVisibility = 'full' | 'productsOnly' | 'hidden';

export interface NavGroup {
  key: GroupKey;
  /** next-intl key for the group label, e.g. 'nav.groups.firm' */
  labelKey: string;
  /** Where clicking the group label goes. */
  landing: string;
  /** Active-matching prefixes (locale-stripped pathname). */
  pathPrefixes: string[];
  members: NavMember[];
  /** Per-role rendering rule. 'productsOnly' = single direct link to /analytics/products. */
  visibility: Record<Role, GroupVisibility>;
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'firm',
    labelKey: 'nav.groups.firm',
    landing: '/analytics/overview',
    pathPrefixes: ['/analytics/overview', '/analytics/products', '/gallery'],
    members: [
      { labelKey: 'nav.firm.overview', href: '/analytics/overview' },
      { labelKey: 'nav.firm.products', href: '/analytics/products' },
      { labelKey: 'nav.firm.gallery', href: '/gallery' },
    ],
    visibility: { admin: 'full', member: 'full', viewer: 'productsOnly' },
  },
  {
    key: 'market',
    labelKey: 'nav.groups.market',
    landing: '/broadcasts',
    pathPrefixes: ['/broadcasts', '/analytics/discovery', '/analytics/strategy', '/analytics/pipeline'],
    members: [
      { labelKey: 'nav.market.broadcasts', href: '/broadcasts' },
      { labelKey: 'nav.market.discovery', href: '/analytics/discovery' },
      { labelKey: 'nav.market.strategy', href: '/analytics/strategy' },
      { labelKey: 'nav.market.pipeline', href: '/analytics/pipeline' },
    ],
    visibility: { admin: 'full', member: 'full', viewer: 'hidden' },
  },
  {
    key: 'produce',
    labelKey: 'nav.groups.produce',
    landing: '/screenplays',
    pathPrefixes: ['/screenplays', '/research'],
    members: [
      { labelKey: 'nav.produce.screenplays', href: '/screenplays' },
      { labelKey: 'nav.produce.research', href: '/research' },
    ],
    visibility: { admin: 'full', member: 'full', viewer: 'hidden' },
  },
  {
    key: 'admin',
    labelKey: 'nav.groups.admin',
    landing: '/admin/users',
    pathPrefixes: ['/admin/users', '/admin/historical-crawl', '/admin/registry', '/admin/preferences', '/admin/discovery-calibration', '/admin/compliance-rules', '/admin/compliance-references'],
    members: [
      { labelKey: 'nav.admin.users', href: '/admin/users' },
      { labelKey: 'nav.admin.historicalCrawl', href: '/admin/historical-crawl' },
      { labelKey: 'nav.admin.discoveryCalibration', href: '/admin/discovery-calibration' },
      { labelKey: 'nav.admin.complianceRules', href: '/admin/compliance-rules' },
      { labelKey: 'nav.admin.complianceReferences', href: '/admin/compliance-references' },
      { labelKey: 'nav.admin.registry', href: '/admin/registry' },
      { labelKey: 'nav.admin.preferences', href: '/admin/preferences' },
    ],
    visibility: { admin: 'full', member: 'hidden', viewer: 'hidden' },
  },
] as const;

/** Strip the locale prefix ("/ko/..." or "/ja/...") for active-matching. Default locale "ja" has no prefix. */
export function stripLocale(pathname: string): string {
  return pathname.replace(/^\/(?:ja|ko)(?=\/|$)/, '') || '/';
}

/** Returns the group whose pathPrefixes match the given pathname, or null. */
export function findActiveGroup(pathname: string): NavGroup | null {
  const stripped = stripLocale(pathname);
  return (
    NAV_GROUPS.find((g) =>
      g.pathPrefixes.some((p) => stripped === p || stripped.startsWith(p + '/')),
    ) ?? null
  );
}

/** Member of the active group whose href matches the pathname. Used for sub-nav active state. */
export function findActiveMember(group: NavGroup, pathname: string): NavMember | null {
  const stripped = stripLocale(pathname);
  return (
    group.members.find((m) => stripped === m.href || stripped.startsWith(m.href + '/')) ?? null
  );
}
