// lib/auth/route-permissions.ts
export type Role = 'admin' | 'member' | 'viewer';

/** All three roles can read these page paths (just viewer-allowed list below). */
export const VIEWER_ALLOWED_PATH_PREFIXES = [
  '/analytics/products', // covers /[locale]/analytics/products and /[locale]/analytics/products/[code]
] as const;

/**
 * Given a pathname like "/ja/analytics/products/12345", returns true if a
 * viewer is permitted to load it. Locale segment is stripped first.
 */
export function isViewerAllowedPath(pathname: string): boolean {
  const stripped = pathname.replace(/^\/(?:en|ja)(?=\/|$)/, '') || '/';
  return VIEWER_ALLOWED_PATH_PREFIXES.some((prefix) =>
    stripped === prefix || stripped.startsWith(prefix + '/'),
  );
}

/**
 * Default role landing pages after login.
 */
export const ROLE_LANDING: Record<Role, string> = {
  admin: '/',
  member: '/',
  viewer: '/analytics/products',
};
