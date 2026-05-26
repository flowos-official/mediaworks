import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/require-user";
import { localePath } from "@/lib/i18n/locale-path";
import RetryButton from "./RetryButton";
import TriggerDetectionButton from "./TriggerDetectionButton";

export const dynamic = "force-dynamic";

const ERROR_REASON_LABELS: Record<string, string> = {
	safety_blocked: "セーフティブロック",
	rate_limited: "レート制限",
	server_error: "サーバーエラー",
	parse_failed: "JSON解析失敗",
	schema_validation_failed: "スキーマ検証失敗",
	extract_empty: "空応答",
	context_load_failed: "コンテキスト読込失敗",
	cron_secret_missing: "CRON_SECRET未設定",
	trigger_not_invoked: "トリガー未起動",
	analysis_timeout: "分析タイムアウト",
	extract_failed: "抽出失敗",
	synthesis_failed: "合成失敗",
	file_too_large: "ファイルサイズ超過",
	no_files: "ファイル未添付",
	unknown: "原因不明",
};

function labelOf(reason: string | null): string {
	if (!reason) return "理由不明";
	const kind = reason.split(":")[0].trim();
	return ERROR_REASON_LABELS[kind] ?? kind;
}

interface PageProps {
  params: Promise<{ locale: string }>;
}

interface PipelineRow {
  id: string;
  name: string;
  status: "analyzing" | "failed";
  error_reason: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function minutesAgo(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

export default async function ResearchPipelinePage({ params }: PageProps) {
  const { locale } = await params;
  const auth = await requireUser(["admin"]);
  if ("error" in auth) redirect(localePath(locale, "/login"));
  const sb = auth.sb;

  const { data: rows } = await sb
    .from("products")
    .select("id, name, status, error_reason, description, created_at, updated_at")
    .in("status", ["analyzing", "failed"])
    .order("updated_at", { ascending: false })
    .limit(100);

  const products = (rows ?? []) as PipelineRow[];
  const analyzing = products.filter((r) => r.status === "analyzing");
  const failed = products.filter((r) => r.status === "failed");

  return (
    <div className="max-w-5xl mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">Research Pipeline</h1>

      <section className="mb-8 border rounded p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">手動 stuck 検出</div>
            <div className="text-xs text-muted-foreground">
              通常は 15 分ごとに自動実行。手動でも今すぐ走らせられます。
            </div>
          </div>
          <TriggerDetectionButton />
        </div>
      </section>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-2">
          進行中 (analyzing) — {analyzing.length} 件
        </h2>
        {analyzing.length === 0 ? (
          <p className="text-sm text-muted-foreground">なし</p>
        ) : (
          <ul className="space-y-2">
            {analyzing.map((p) => (
              <li key={p.id} className="border rounded p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    開始: {p.created_at.slice(11, 16)} ({minutesAgo(p.updated_at)} 分前更新)
                  </div>
                </div>
                <RetryButton productId={p.id} label="強制再試行" />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-2">失敗 (failed) — {failed.length} 件</h2>
        {failed.length === 0 ? (
          <p className="text-sm text-muted-foreground">なし</p>
        ) : (
          <ul className="space-y-2">
            {failed.map((p) => (
              <li key={p.id} className="border rounded p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {labelOf(p.error_reason)} · {p.error_reason ?? "理由不明"} · 失敗時刻: {p.updated_at.slice(11, 16)}
                    {p.description == null ? " · description 未抽出 (要再アップロード)" : ""}
                  </div>
                </div>
                <RetryButton productId={p.id} label="再試行" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
