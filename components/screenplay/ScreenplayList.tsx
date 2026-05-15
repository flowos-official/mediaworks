"use client";
import Link from "next/link";

interface Row {
  id: string;
  title: string;
  status: "pending" | "generating" | "ready" | "failed";
  updated_at: string;
}

const STATUS_LABEL: Record<Row["status"], string> = {
  pending: "待機",
  generating: "生成中",
  ready: "完成",
  failed: "失敗",
};

export function ScreenplayList({ rows, locale }: { rows: Row[]; locale: string }) {
  if (rows.length === 0) {
    return <p className="text-sm text-zinc-500">まだ台本はありません。「新規作成」から始めてください。</p>;
  }
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/${locale}/screenplays/${r.id}`} className="block rounded border border-zinc-200 bg-white p-4 hover:border-zinc-900 transition-colors">
            <div className="text-sm font-bold truncate">{r.title}</div>
            <div className="text-xs text-zinc-500 mt-1">
              {STATUS_LABEL[r.status]} ・ {new Date(r.updated_at).toLocaleString("ja-JP")}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
