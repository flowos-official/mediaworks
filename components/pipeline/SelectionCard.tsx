"use client";

/* eslint-disable @next/next/no-img-element -- Selection cards retain externally sourced thumbnails without proxying. */
// TODO(image-domains): next.config.ts only whitelists S3/CloudFront hosts.
// discovered_products.thumbnail_url may point to external product image hosts
// (e.g. Rakuten, QVC). Using a plain <img> here to match the pattern in
// components/discovery/ProductCard.tsx until image domains are whitelisted.
import type { BoardCard } from "@/lib/selections/types";
import { CardMenu } from "./CardMenu";
import { useTranslations } from "next-intl";

export function SelectionCard({ card, canWrite, onChanged }: { card: BoardCard; canWrite: boolean; onChanged?: () => void }) {
  const p = card.product;
  const t = useTranslations("pipeline");
  return (
    <article className="relative rounded-lg border border-border bg-background p-3 shadow-sm transition hover:border-primary/25 hover:shadow-md" data-selection-id={card.id}>
      <div className="absolute top-2 right-2">{canWrite && <CardMenu card={card} onChanged={onChanged ?? (() => undefined)} />}</div>
      <div className="flex gap-2">
        {p.thumbnail_url && (
          <div className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
            <img
              src={p.thumbnail_url}
              alt={p.name}
              className="w-full h-full object-cover"
            />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <p className="line-clamp-2 pr-5 text-xs font-semibold leading-relaxed">{p.name}</p>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
            {p.price_jpy ? `¥${p.price_jpy.toLocaleString()}` : "—"}
            {typeof p.tv_fit_score === "number" && (
              <span className="ml-1">· TV適 {p.tv_fit_score}</span>
            )}
          </p>
        </div>
      </div>
      {card.status === "scheduled" && (
        <p className="mt-2 rounded-md border border-blue-500/15 bg-blue-500/8 px-2 py-1.5 text-[11px]">
          {card.broadcast
            ? `📺 ${card.broadcast.channel.toUpperCase()} · ${card.broadcast.air_date} ${card.broadcast.start_time}`
            : `📝 ${card.scheduled_note ?? t("manualEntry")}`}
        </p>
      )}
      {card.status === "closed" && (
        <p className="mt-2 rounded-md border border-emerald-500/15 bg-emerald-500/8 px-2 py-1.5 text-[11px]">
          {card.closed_reason === "aired" && `✅ ${t("aired")} ${card.closed_at?.slice(0, 10) ?? ""}`}
          {card.closed_reason === "dropped" && `🚫 ${t("dropped")} ${card.closed_at?.slice(0, 10) ?? ""}`}
          {card.closed_reason === "postponed" && `⏸ ${t("postponed")} ${card.closed_at?.slice(0, 10) ?? ""}`}
          {!card.closed_reason && `${t("closed")} ${card.closed_at?.slice(0, 10) ?? ""}`}
        </p>
      )}
      {card.status === "sourcing" && card.sourcing_note && (
        <p className="mt-2 line-clamp-3 rounded-md border border-amber-500/15 bg-amber-500/8 px-2 py-1.5 text-[11px]">
          {card.sourcing_note}
        </p>
      )}
      <footer className="mt-2 flex items-center justify-between border-t border-border pt-2 font-mono text-[9px] text-muted-foreground">
        <span>
          {(card.owner?.display_name ?? card.owner?.email)?.slice(0, 12)}
          {card.assignee && card.assignee_id !== card.owner_id && (
            <> → {(card.assignee.display_name ?? card.assignee.email).slice(0, 12)}</>
          )}
        </span>
        {!canWrite && <span>{t("readOnly")}</span>}
      </footer>
    </article>
  );
}
