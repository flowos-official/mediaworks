/**
 * Codemod: insert `requireUser` gate at the start of every HTTP method handler
 * in the given route files. Idempotent — does nothing if the gate already exists.
 *
 * Run: tsx scripts/codemod-add-require-user.ts
 */

import { readFileSync, writeFileSync } from 'fs';

type Roles = 'admin' | 'member' | 'viewer';

interface Target {
  file: string;
  roles: Roles[];
}

// Routes that take ['member','admin'] (most user-facing routes)
const MEMBER_ROUTES: string[] = [
  'app/api/analytics/expansion/route.ts',
  'app/api/analytics/gallery/route.ts',
  'app/api/analytics/trends/route.ts',
  'app/api/analytics/overview/route.ts',
  'app/api/analytics/discovery/route.ts',
  'app/api/analytics/discovery/[sessionId]/route.ts',
  'app/api/analytics/discovery/analyze/route.ts',
  'app/api/analytics/live-commerce/route.ts',
  'app/api/analytics/live-commerce/[id]/route.ts',
  'app/api/analytics/live-commerce/[id]/rediscover/route.ts',
  'app/api/analytics/live-commerce/run/[runId]/status/route.ts',
  'app/api/analytics/live-commerce/run/[runId]/stream/route.ts',
  'app/api/analytics/md-strategy/route.ts',
  'app/api/analytics/md-strategy/[id]/route.ts',
  'app/api/analytics/md-strategy/[id]/rediscover/route.ts',
  'app/api/analytics/md-strategy/run/[runId]/status/route.ts',
  'app/api/analytics/md-strategy/run/[runId]/stream/route.ts',
  'app/api/broadcasts/route.ts',
  'app/api/discovery/enrich/[productId]/route.ts',
  'app/api/discovery/history/route.ts',
  'app/api/discovery/insights/route.ts',
  'app/api/discovery/sessions/route.ts',
  'app/api/discovery/sessions/[id]/route.ts',
  'app/api/discovery/selections/route.ts',
  'app/api/discovery/today/route.ts',
  'app/api/products/route.ts',
  'app/api/products/[id]/route.ts',
  'app/api/products/upload-taicho/route.ts',
  'app/api/recommend/route.ts',
  'app/api/upload/route.ts',
  'app/api/analyze/route.ts',
];

const TARGETS: Target[] = [
  ...MEMBER_ROUTES.map((file) => ({ file, roles: ['member', 'admin'] as Roles[] })),
  { file: 'app/api/discovery/manual-trigger/route.ts', roles: ['admin'] },
];

const HTTP_METHOD_RE = /(\bexport\s+async\s+function\s+)(GET|POST|PATCH|DELETE|PUT)(\s*\()/g;
const IMPORT_LINE = `import { requireUser } from "@/lib/auth/require-user";`;
const SENTINEL = '// auth: requireUser';

function gateSnippet(roles: Roles[]): string {
  const rolesStr = roles.map((r) => `"${r}"`).join(', ');
  return `\n\t${SENTINEL}\n\tconst auth = await requireUser([${rolesStr}]);\n\tif ("error" in auth) return auth.error;\n`;
}

function applyOne(target: Target): { changed: boolean; note: string } {
  let src: string;
  try {
    src = readFileSync(target.file, 'utf-8');
  } catch (e) {
    return { changed: false, note: `MISSING ${target.file}` };
  }

  if (src.includes(SENTINEL)) {
    return { changed: false, note: `SKIP (already gated) ${target.file}` };
  }

  // Step 1: insert import after the last existing `import ... from "..."` line
  if (!src.includes('@/lib/auth/require-user')) {
    const importRegex = /^(import [^\n]+from [^\n]+;\n)+/m;
    const m = src.match(importRegex);
    if (m) {
      src = src.replace(importRegex, m[0] + IMPORT_LINE + '\n');
    } else {
      src = IMPORT_LINE + '\n' + src;
    }
  }

  // Step 2: inject the gate right after the `{` that opens the function body.
  // Use paren-balance walking (not regex) so destructured params in the
  // signature don't confuse us.
  const snippet = gateSnippet(target.roles);
  let injected = 0;
  const startRe = /\bexport\s+async\s+function\s+(GET|POST|PATCH|DELETE|PUT)\b/g;
  const matches = Array.from(src.matchAll(startRe));
  const insertions: { at: number }[] = [];
  for (const m of matches) {
    if (m.index === undefined) continue;
    let i = m.index + m[0].length;
    while (i < src.length && src[i] !== '(') i += 1;
    if (i >= src.length) continue;
    let depth = 1;
    i += 1;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    while (i < src.length && src[i] !== '{') i += 1;
    if (i >= src.length) continue;
    insertions.push({ at: i + 1 });
  }
  // Apply insertions in reverse so indices don't shift
  for (let k = insertions.length - 1; k >= 0; k -= 1) {
    const at = insertions[k].at;
    src = src.slice(0, at) + snippet + src.slice(at);
    injected += 1;
  }

  if (injected === 0) {
    return { changed: false, note: `NO HANDLERS found in ${target.file}` };
  }

  writeFileSync(target.file, src, 'utf-8');
  return { changed: true, note: `gated ${injected} handler(s): ${target.file}` };
}

function main(): void {
  let okCount = 0;
  let skipCount = 0;
  let errCount = 0;
  for (const t of TARGETS) {
    const r = applyOne(t);
    console.log(r.changed ? 'OK   ' : '     ', r.note);
    if (r.changed) okCount += 1;
    else if (r.note.startsWith('SKIP')) skipCount += 1;
    else errCount += 1;
  }
  console.log(`\nSummary: ${okCount} changed, ${skipCount} already-gated, ${errCount} errors`);
  process.exit(errCount > 0 ? 1 : 0);
}

main();
