/**
 * 単位テスト: checkMagicBytes の 6 ケース。
 * 実行: npm run test:magic-bytes
 */
import { checkMagicBytes } from "../lib/upload/magic-bytes";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function bufOf(...bytes: number[]): Buffer {
  const arr = [...bytes];
  while (arr.length < 16) arr.push(0x00);
  return Buffer.from(arr);
}

function main(): void {
  // 1) PDF magic + declared PDF → match
  const pdf = bufOf(0x25, 0x50, 0x44, 0x46);
  const r1 = checkMagicBytes(pdf, "application/pdf");
  assert(r1.kind === "match" && r1.detectedMime === "application/pdf",
    `PDF magic should match, got ${JSON.stringify(r1)}`);

  // 2) HTML payload + declared PDF → not match (mismatch or unsupported)
  const html = Buffer.from("<!DOCTYPE html><html>body</html>", "utf8");
  const r2 = checkMagicBytes(html, "application/pdf");
  assert(r2.kind !== "match", `HTML body should not match PDF mime, got ${r2.kind}`);

  // 3) PNG magic + declared PNG → match
  const png = bufOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const r3 = checkMagicBytes(png, "image/png");
  assert(r3.kind === "match" && r3.detectedMime === "image/png",
    `PNG magic should match, got ${JSON.stringify(r3)}`);

  // 4) ZIP magic + declared PPTX → match (treated as OOXML)
  const zip = bufOf(0x50, 0x4b, 0x03, 0x04);
  const r4 = checkMagicBytes(zip, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert(r4.kind === "match",
    `ZIP magic + PPTX declared should match, got ${JSON.stringify(r4)}`);

  // 5) ZIP magic + declared PDF → mismatch
  const r5 = checkMagicBytes(zip, "application/pdf");
  assert(r5.kind === "mismatch",
    `ZIP magic + PDF declared should mismatch, got ${JSON.stringify(r5)}`);

  // 6) Short buffer (<12 bytes) → unsupported
  const tiny = Buffer.from([0x25, 0x50]);
  const r6 = checkMagicBytes(tiny, "application/pdf");
  assert(r6.kind === "unsupported",
    `short buffer → unsupported, got ${r6.kind}`);

  console.log("[ok] checkMagicBytes 全6ケース通過");
}

main();
