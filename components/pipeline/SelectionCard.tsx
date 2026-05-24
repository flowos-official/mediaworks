"use client";
// TODO(image-domains): next.config.ts only whitelists S3/CloudFront hosts.
// discovered_products.thumbnail_url may point to external product image hosts
// (e.g. Rakuten, QVC). Using a plain <img> here to match the pattern in
// components/discovery/ProductCard.tsx until image domains are whitelisted.
import type { BoardCard } from "@/lib/selections/types";

export function SelectionCard({ card, canWrite }: { card: BoardCard; canWrite: boolean }) {
  const p = card.product;
  return (
    <article className="bg-card border border-border rounded-lg p-3 shadow-sm">
      <div className="flex gap-2">
        {p.thumbnail_url && (
          <div className="w-12 h-12 relative shrink-0 rounded overflow-hidden">
            <img
              src={p.thumbnail_url}
              alt={p.name}
              className="w-full h-full object-cover"
            />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold line-clamp-2">{p.name}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            {p.price_jpy ? `¥${p.price_jpy.toLocaleString()}` : "—"}
            {typeof p.tv_fit_score === "number" && (
              <span className="ml-1">· TV適 {p.tv_fit_score}</span>
            )}
          </p>
        </div>
      </div>
      {card.status === "scheduled" && (
        <p className="text-[11px] mt-2 px-2 py-1 bg-blue-50 dark:bg-blue-950/40 rounded">
          {card.broadcast
            ? `📺 ${card.broadcast.channel.toUpperCase()} · ${card.broadcast.air_date}${card.broadcast.start_time ? ` ${card.broadcast.start_time}` : ""}`
            : `📝 ${card.scheduled_note ?? "수동 입력"}`}
        </p>
      )}
      {card.status === "closed" && (
        <p className="text-[11px] mt-2 px-2 py-1 bg-emerald-50 dark:bg-emerald-950/40 rounded">
          {card.closed_reason === "aired" && `✅ 방송완료 ${card.closed_at?.slice(0, 10) ?? ""}`}
          {card.closed_reason === "dropped" && `🚫 드롭 ${card.closed_at?.slice(0, 10) ?? ""}`}
          {card.closed_reason === "postponed" && `⏸ 보류 ${card.closed_at?.slice(0, 10) ?? ""}`}
        </p>
      )}
      {card.status === "sourcing" && card.sourcing_note && (
        <p className="text-[11px] mt-2 px-2 py-1 bg-amber-50 dark:bg-amber-950/40 rounded line-clamp-3">
          {card.sourcing_note}
        </p>
      )}
      <footer className="flex items-center justify-between mt-2 text-[10px] text-muted-foreground">
        <span>
          {(card.owner?.display_name ?? card.owner?.email)?.slice(0, 12)}
          {card.assignee && card.assignee_id !== card.owner_id && (
            <> → {(card.assignee.display_name ?? card.assignee.email).slice(0, 12)}</>
          )}
        </span>
        {!canWrite && <span>읽기 전용</span>}
      </footer>
    </article>
  );
}
