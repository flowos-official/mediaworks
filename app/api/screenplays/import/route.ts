// app/api/screenplays/import/route.ts
import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { normalizeDraft, DraftTooLongError } from "@/lib/screenplay/import";

export const maxDuration = 120;

// The .docx is parsed to text in the BROWSER (mammoth) and only the extracted
// text is POSTed here as JSON. This keeps the request far under Vercel's
// serverless body limit (~4.5 MB) even for large, image-heavy Word files — the
// images never leave the browser; only the script text (small) is sent.
const MAX_TEXT_CHARS = 50_000;

export async function POST(request: NextRequest) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "リクエスト本文が必要です" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const rawText = typeof b.text === "string" ? b.text.trim() : "";
  const fileName =
    typeof b.fileName === "string" && b.fileName.trim() ? b.fileName.trim().slice(0, 200) : "draft.docx";

  if (!rawText) {
    return NextResponse.json(
      { error: "台本のテキストが空です。Word ファイルから文章を読み取れませんでした。" },
      { status: 400 },
    );
  }
  if (rawText.length > MAX_TEXT_CHARS) {
    return NextResponse.json(
      { error: `台本が長すぎます（最大 ${MAX_TEXT_CHARS.toLocaleString()} 文字）。短く分割してお試しください。` },
      { status: 413 },
    );
  }

  try {
    const { markdown, brief } = await normalizeDraft(rawText, fileName);
    return NextResponse.json({ markdown, brief, source: { kind: "docx", fileName, chars: rawText.length } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[screenplays/import] failed:", msg);
    // Surface only our own actionable error; mask provider/parser internals.
    if (err instanceof DraftTooLongError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    return NextResponse.json(
      { error: "取り込みに失敗しました。しばらくしてからもう一度お試しください。" },
      { status: 500 },
    );
  }
}
