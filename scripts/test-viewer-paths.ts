/**
 * Unit-test the viewer path allow-list logic. No DB, no auth — pure function.
 */
import { isViewerAllowedPath } from '@/lib/auth/route-permissions';

interface Case { path: string; expect: boolean }

const CASES: Case[] = [
  // Allowed (TXD analytics)
  { path: '/ja/analytics/products', expect: true },
  { path: '/ko/analytics/products', expect: true },
  { path: '/ja/analytics/products/12345', expect: true },
  { path: '/ko/analytics/products/abc123', expect: true },
  { path: '/analytics/products', expect: true }, // default locale (no prefix)
  { path: '/analytics/products/12345', expect: true },
  // Disallowed
  { path: '/ja', expect: false },
  { path: '/ko', expect: false },
  { path: '/ja/broadcasts', expect: false },
  { path: '/ja/analytics', expect: false },
  { path: '/ja/analytics/discovery', expect: false },
  { path: '/ja/analytics/strategy', expect: false },
  { path: '/ja/products/abc', expect: false },
  { path: '/ja/admin/users', expect: false },
  // Edge cases
  { path: '/', expect: false },
  { path: '/ja/analytics/products-other', expect: false }, // prefix-trap
];

let passed = 0;
let failed = 0;
for (const c of CASES) {
  const got = isViewerAllowedPath(c.path);
  const ok = got === c.expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.path.padEnd(40)} expected=${c.expect}, got=${got}`);
  if (ok) passed += 1;
  else failed += 1;
}
console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
