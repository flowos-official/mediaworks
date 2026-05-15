"use client";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

interface Row {
  id: string;
  title: string;
  status: "pending" | "generating" | "ready" | "failed";
  updated_at: string;
}

const STATUS_LABEL: Record<Row["status"], string> = {
  pending: "WAIT",
  generating: "ROLL",
  ready: "TAKE",
  failed: "NG",
};

const STATUS_DOT: Record<Row["status"], string> = {
  pending: "bg-stone-300",
  generating: "bg-stone-900 animate-pulse",
  ready: "bg-stone-900",
  failed: "bg-stone-200 border border-stone-900",
};

function pad(n: number, w: number): string {
  return n.toString().padStart(w, "0");
}

function formatStamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1, 2)}.${pad(d.getDate(), 2)} · ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}`;
}

export function ScreenplayList({ rows, locale }: { rows: Row[]; locale: string }) {
  if (rows.length === 0) {
    return (
      <div className="border-y border-stone-900 py-20 text-center">
        <div className="font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500 mb-3">no entries</div>
        <p className="text-sm text-stone-600">
          まだ台本は登録されていません。<br className="hidden sm:block" />
          右上「<span className="font-bold text-stone-900">新規台本</span>」から作成を開始してください。
        </p>
      </div>
    );
  }
  return (
    <div className="border-t border-stone-900">
      <div className="grid grid-cols-[64px_1fr_120px_180px_28px] gap-0 border-b border-stone-200 py-3 px-0 font-mono text-[10px] tracking-[0.25em] uppercase text-stone-500">
        <div>No.</div>
        <div>Title</div>
        <div>Status</div>
        <div>Last Revised</div>
        <div></div>
      </div>
      <ol>
        {rows.map((r, i) => (
          <li key={r.id} className="group border-b border-stone-200 last:border-b-0 hover:bg-stone-100/70 transition-colors">
            <Link
              href={`/${locale}/screenplays/${r.id}`}
              className="grid grid-cols-[64px_1fr_120px_180px_28px] items-baseline gap-0 py-5 px-0"
            >
              <div className="font-mono text-xs tracking-widest text-stone-400 tabular-nums">{pad(rows.length - i, 3)}</div>
              <div className="text-[15px] font-bold leading-snug pr-6 [font-family:var(--font-jp)] text-stone-900">
                {r.title}
              </div>
              <div className="flex items-center gap-2">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${STATUS_DOT[r.status]}`} />
                <span className="font-mono text-[10px] tracking-[0.25em] uppercase text-stone-700">{STATUS_LABEL[r.status]}</span>
              </div>
              <div className="font-mono text-[11px] text-stone-500 tabular-nums">{formatStamp(r.updated_at)}</div>
              <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                <ArrowUpRight className="h-4 w-4 text-stone-900" strokeWidth={1.5} />
              </div>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
