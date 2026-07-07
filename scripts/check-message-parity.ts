/**
 * Verify that messages/ja.json and messages/ko.json share an identical key set.
 * next-intl resolves every UI string by key, so a key present in one locale but
 * missing in the other surfaces as a runtime MISSING_MESSAGE error in that locale.
 * Usage: npx tsx scripts/check-message-parity.ts   (alias: npm run check:i18n)
 */

import ja from "../messages/ja.json";
import ko from "../messages/ko.json";

function keys(obj: unknown, prefix = ""): string[] {
  if (!obj || typeof obj !== "object") return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    keys(v, prefix ? `${prefix}.${k}` : k),
  );
}

const jaKeys = new Set(keys(ja));
const koKeys = new Set(keys(ko));
const onlyJa = [...jaKeys].filter((k) => !koKeys.has(k));
const onlyKo = [...koKeys].filter((k) => !jaKeys.has(k));

if (onlyJa.length || onlyKo.length) {
  console.error("KEY MISMATCH");
  if (onlyJa.length) console.error("  ja-only:", onlyJa);
  if (onlyKo.length) console.error("  ko-only:", onlyKo);
  process.exit(1);
}
console.log(`OK — ${jaKeys.size} keys match`);
