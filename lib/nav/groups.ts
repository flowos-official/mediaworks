// lib/nav/groups.ts
import type { Role } from '@/lib/auth/route-permissions';
import { isFeatureEnabled, type AppFeature } from '@/config/app';
import { stripLocalePrefix } from '@/lib/i18n/locale-path';

export type GroupKey = 'firm' | 'market' | 'produce' | 'admin';

export interface NavMember {
  /** next-intl translation key, e.g. 'nav.firm.overview' */
  labelKey: string;
  /** Locale-agnostic path; pass through localePath() at render time. */
  href: string;
  /** Optional per-member role filter inside an otherwise visible group. */
  roles?: readonly Role[];
  /** Product capability required to render this destination. */
  feature: AppFeature;
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
      { labelKey: 'nav.firm.overview', href: '/analytics/overview', feature: 'firmAnalytics' },
      { labelKey: 'nav.firm.products', href: '/analytics/products', feature: 'firmAnalytics' },
      { labelKey: 'nav.firm.gallery', href: '/gallery', feature: 'firmAnalytics' },
    ],
    visibility: { admin: 'full', member: 'full', viewer: 'productsOnly' },
  },
  {
    key: 'market',
    labelKey: 'nav.groups.market',
    landing: '/broadcasts',
    pathPrefixes: ['/broadcasts', '/analytics/discovery', '/analytics/strategy', '/analytics/pipeline', '/analytics/product-finder'],
    members: [
      { labelKey: 'nav.market.broadcasts', href: '/broadcasts', roles: ['admin', 'member'], feature: 'broadcastCalendar' },
      { labelKey: 'nav.market.discovery', href: '/analytics/discovery', roles: ['admin', 'member'], feature: 'productDiscovery' },
      { labelKey: 'nav.market.strategy', href: '/analytics/strategy', roles: ['admin', 'member'], feature: 'strategy' },
      { labelKey: 'nav.market.pipeline', href: '/analytics/pipeline', roles: ['admin', 'member', 'viewer'], feature: 'selectionPipeline' },
      // Member|admin only: the finder reads evidence derived from member-only
      // sources, so a viewer would reach an empty page at best.
      { labelKey: 'nav.market.productFinder', href: '/analytics/product-finder', roles: ['admin', 'member'], feature: 'productFinder' },
      // Member|admin only, and for a stronger reason than the finder: these
      // pages show file names and the contents of an operator's own cost book.
      { labelKey: 'nav.market.dataManagement', href: '/analytics/data-management', roles: ['admin', 'member'], feature: 'dataManagement' },
    ],
    visibility: { admin: 'full', member: 'full', viewer: 'full' },
  },
  {
    key: 'produce',
    labelKey: 'nav.groups.produce',
    landing: '/screenplays',
    pathPrefixes: ['/screenplays', '/research'],
    members: [
      { labelKey: 'nav.produce.screenplays', href: '/screenplays', feature: 'screenplays' },
      { labelKey: 'nav.produce.research', href: '/research', feature: 'research' },
    ],
    visibility: { admin: 'full', member: 'full', viewer: 'hidden' },
  },
  {
    key: 'admin',
    labelKey: 'nav.groups.admin',
    landing: '/admin/users',
    pathPrefixes: ['/admin/users', '/admin/historical-crawl', '/admin/archive-status', '/admin/registry', '/admin/preferences', '/admin/discovery-calibration', '/admin/research-pipeline', '/admin/compliance-rules', '/admin/compliance-references'],
    members: [
      { labelKey: 'nav.admin.users', href: '/admin/users', feature: 'adminOperations' },
      { labelKey: 'nav.admin.historicalCrawl', href: '/admin/historical-crawl', feature: 'adminOperations' },
      { labelKey: 'nav.admin.archiveStatus', href: '/admin/archive-status', feature: 'adminOperations' },
      { labelKey: 'nav.admin.discoveryCalibration', href: '/admin/discovery-calibration', feature: 'adminOperations' },
      { labelKey: 'nav.admin.researchPipeline', href: '/admin/research-pipeline', feature: 'adminOperations' },
      { labelKey: 'nav.admin.complianceRules', href: '/admin/compliance-rules', feature: 'adminOperations' },
      { labelKey: 'nav.admin.complianceReferences', href: '/admin/compliance-references', feature: 'adminOperations' },
      { labelKey: 'nav.admin.registry', href: '/admin/registry', feature: 'adminOperations' },
      { labelKey: 'nav.admin.preferences', href: '/admin/preferences', feature: 'adminOperations' },
    ],
    visibility: { admin: 'full', member: 'hidden', viewer: 'hidden' },
  },
] as const;

/** Strip the configured locale prefix for active route matching. */
export function stripLocale(pathname: string): string {
  return stripLocalePrefix(pathname);
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

export function visibleMembersForRole(group: NavGroup, role: Role): NavMember[] {
  return group.members.filter((m) => isFeatureEnabled(m.feature) && (!m.roles || m.roles.includes(role)));
}
