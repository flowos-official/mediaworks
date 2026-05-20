import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import {
  extractBriefFromFile,
  extractBriefFromExcel,
  extractBriefFromUrl,
  isLikelyPublicHttpUrl,
  SUPPORTED_VISION_MIME,
} from "@/lib/screenplay/extract";

export const maxDuration = 120;

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

const EXCEL_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  "application/vnd.ms-excel",                                          // .xls
  "application/vnd.oasis.opendocument.spreadsheet",                    // .ods
]);

function detectExcelByName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".xlsm") || lower.endsWith(".ods");
}

export async function POST(request: NextRequest) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

  try {
    if (contentType.includes("application/json")) {
      const body = await request.json().catch(() => null);
      const url = body && typeof (body as { url?: unknown }).url === "string" ? (body as { url: string }).url.trim() : "";
      if (!url) return NextResponse.json({ error: "url を指定してください" }, { status: 400 });
      if (!isLikelyPublicHttpUrl(url)) {
        return NextResponse.json({ error: "有効な http/https の公開 URL を入力してください" }, { status: 400 });
      }
      const { brief, imageCount, finalUrl } = await extractBriefFromUrl(url);
      return NextResponse.json({
        brief,
        source: { kind: "url", url, finalUrl, imageCount },
      });
    }

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "file フィールドにファイルを添付してください" }, { status: 400 });
      }
      if (file.size === 0) {
        return NextResponse.json({ error: "ファイルが空です" }, { status: 400 });
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return NextResponse.json({ error: "ファイルサイズが大きすぎます (最大 25MB)" }, { status: 413 });
      }
      const fileName = file.name || "upload";
      const declaredMime = (file.type || "").toLowerCase();
      const buffer = Buffer.from(await file.arrayBuffer());

      // Route: Excel first (by mime or extension), then Vision-supported (PDF/image).
      const isExcel = EXCEL_MIMES.has(declaredMime) || detectExcelByName(fileName);
      if (isExcel) {
        const brief = await extractBriefFromExcel(buffer, fileName);
        return NextResponse.json({
          brief,
          source: { kind: "excel", fileName, size: file.size },
        });
      }
      if (SUPPORTED_VISION_MIME.has(declaredMime)) {
        const brief = await extractBriefFromFile(buffer.toString("base64"), declaredMime, fileName);
        return NextResponse.json({
          brief,
          source: { kind: declaredMime === "application/pdf" ? "pdf" : "image", fileName, mimeType: declaredMime, size: file.size },
        });
      }
      return NextResponse.json(
        { error: `非対応のファイル形式です: ${declaredMime || "不明"} (${fileName})。PDF / 画像 / Excel に対応しています。` },
        { status: 415 },
      );
    }

    return NextResponse.json(
      { error: "Content-Type は application/json か multipart/form-data を指定してください" },
      { status: 415 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[screenplays/extract] failed:", msg);
    return NextResponse.json({ error: `抽出に失敗しました: ${msg}` }, { status: 500 });
  }
}
