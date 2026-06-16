// app/api/screenplays/import/route.ts
import { NextRequest, NextResponse } from "next/server";
import AdmZip from "adm-zip";
import { requireUser } from "@/lib/auth/require-user";
import { extractDocxText, normalizeDraft } from "@/lib/screenplay/import";
import { checkMagicBytes } from "@/lib/upload/magic-bytes";

export const maxDuration = 120;

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function POST(request: NextRequest) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;

  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Content-Type は multipart/form-data を指定してください" }, { status: 415 });
  }

  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file フィールドにファイルを添付してください" }, { status: 400 });
    }
    if (file.size === 0) return NextResponse.json({ error: "ファイルが空です" }, { status: 400 });
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json({ error: "ファイルサイズが大きすぎます (最大 25MB)" }, { status: 413 });
    }

    const fileName = file.name || "draft.docx";
    const lower = fileName.toLowerCase();
    const buffer = Buffer.from(await file.arrayBuffer());

    // .docx only. Magic bytes must be a ZIP/OOXML container; .doc (OLE2) → 415.
    const magic = checkMagicBytes(buffer, DOCX_MIME);
    if (!lower.endsWith(".docx") || magic.kind !== "match") {
      const isLegacyDoc =
        lower.endsWith(".doc") || ("detectedMime" in magic && magic.detectedMime === "application/x-cfb");
      return NextResponse.json(
        {
          error: isLegacyDoc
            ? "旧 .doc 形式は非対応です。Word で「.docx」形式に保存し直してアップロードしてください。"
            : `非対応のファイル形式です (${fileName})。Word の .docx のみ対応しています。`,
        },
        { status: 415 },
      );
    }
    // checkMagicBytes accepts ANY zip for an OOXML-declared mime, so a renamed
    // .xlsx / arbitrary .zip would pass the magic gate and only fail later inside
    // mammoth (→ 500). Confirm it is actually a Word doc by inspecting the OOXML part.
    try {
      if (!new AdmZip(buffer).getEntry("word/document.xml")) {
        return NextResponse.json(
          { error: `Word 文書 (.docx) ではありません (${fileName})。` },
          { status: 415 },
        );
      }
    } catch {
      return NextResponse.json(
        { error: `Word ファイルを開けませんでした (${fileName})。ファイルが壊れている可能性があります。` },
        { status: 415 },
      );
    }

    const { text } = await extractDocxText(buffer);
    const { markdown, brief } = await normalizeDraft(text, fileName);

    return NextResponse.json({
      markdown,
      brief,
      source: { kind: "docx", fileName, size: file.size },
    });
  } catch (err) {
    // Log the detail server-side, but do NOT surface the raw error to the client:
    // this path runs mammoth + Gemini, whose error messages can echo provider/parser
    // internals. Member/admin-gated, but still return a fixed user-facing message.
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[screenplays/import] failed:", msg);
    return NextResponse.json({ error: "取り込みに失敗しました。ファイル形式を確認して、しばらくしてからもう一度お試しください。" }, { status: 500 });
  }
}
