import { useTranslations } from "next-intl";
import { ExternalLink, ShoppingBag, PlayCircle, Play, Loader2 } from "lucide-react";
import ChannelBadge from "./ChannelBadge";
import { CompetitorFitPanel } from "./CompetitorFitPanel";

export interface QvcProduct {
  id: string;
  name: string | null;
  description: string | null;
  image_url: string | null;
  video_url: string | null;
  price_text: string | null;
  source_url: string;
}

export interface Broadcast {
  id: string;
  channel: "shopch" | "qvc";
  air_date: string;
  start_time: string;
  program_title: string;
  presenter: string | null;
  description: string | null;
  thumbnail_url: string | null;
  source_url: string;
  product_ids?: string[] | null;
  products?: QvcProduct[] | null;
  category?: string | null;
  archived_video_s3?: string | null;
  video_status?: string | null;
  brand_name?: string | null;
  brand_code?: string | null;
}

interface Props {
  broadcast: Broadcast;
  onPlayVideo?: (b: Broadcast) => void;
}

function formatTime(t: string): string {
  return t.slice(0, 5);
}

function isProductImage(b: Broadcast): boolean {
  if (!b.thumbnail_url) return false;
  if (b.thumbnail_url.includes("/navigator/")) return false;
  return true;
}

const CHANNEL_PLACEHOLDER: Record<Broadcast["channel"], string> = {
  shopch: "bg-red-600/10 text-red-400",
  qvc: "bg-violet-600/10 text-violet-400",
};

function ShopchHeader({ b }: { b: Broadcast }) {
  // Shop Channel: description is the actual product name; program_title is repeating corner.
  const productName = b.description ?? b.program_title;
  const context = b.description ? b.program_title : null;
  const showImg = isProductImage(b);
  return (
    <div className="flex gap-3">
      {showImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={b.thumbnail_url!}
          alt=""
          className="w-20 h-20 object-cover rounded flex-shrink-0 bg-muted"
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).style.visibility = "hidden";
          }}
        />
      ) : (
        <div className={`w-20 h-20 rounded flex-shrink-0 flex items-center justify-center ${CHANNEL_PLACEHOLDER[b.channel]}`}>
          <ShoppingBag size={28} strokeWidth={1.5} />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <span className="font-mono font-semibold text-foreground">{formatTime(b.start_time)}</span>
          <ChannelBadge channel={b.channel} />
          {b.presenter && (
            <span className="text-muted-foreground truncate max-w-[12rem]">· {b.presenter}</span>
          )}
        </div>
        <div className="font-semibold text-foreground mt-1 text-base line-clamp-2 leading-snug">
          {productName}
        </div>
        {context && (
          <div className="text-xs text-muted-foreground mt-1 truncate">{context}</div>
        )}
      </div>
    </div>
  );
}

function QvcHeader({ b }: { b: Broadcast }) {
  return (
    <div className="flex items-center gap-2 text-xs flex-wrap">
      <span className="font-mono font-semibold text-foreground">{formatTime(b.start_time)}</span>
      <ChannelBadge channel={b.channel} />
      <span className="font-semibold text-sm text-foreground truncate max-w-[28rem]">
        {b.program_title}
      </span>
      {b.presenter && (
        <span className="text-muted-foreground truncate max-w-[10rem]">· {b.presenter}</span>
      )}
    </div>
  );
}

function ProductCard({ p }: { p: QvcProduct }) {
  return (
    <a
      href={p.source_url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex gap-2 p-2 rounded border border-border bg-card hover:border-violet-500/40 hover:bg-violet-600/10 transition-colors"
    >
      {p.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={p.image_url}
          alt=""
          className="w-16 h-16 object-cover rounded flex-shrink-0 bg-muted"
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).style.visibility = "hidden";
          }}
        />
      ) : (
        <div className="w-16 h-16 bg-violet-600/10 text-violet-400 rounded flex-shrink-0 flex items-center justify-center">
          <ShoppingBag size={20} strokeWidth={1.5} />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-foreground line-clamp-2 leading-tight group-hover:text-violet-800 dark:group-hover:text-violet-300">
          {p.name ?? `Product #${p.id}`}
        </div>
        <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground">
          <span className="font-mono">#{p.id}</span>
          {p.video_url && (
            <span className="inline-flex items-center gap-0.5 text-violet-600">
              <PlayCircle size={10} /> video
            </span>
          )}
          {p.price_text && <span className="truncate">{p.price_text}</span>}
        </div>
      </div>
    </a>
  );
}

export default function BroadcastListItem({ broadcast, onPlayVideo }: Props) {
  const t = useTranslations("broadcasts");
  const b = broadcast;
  const hasProducts = b.channel === "qvc" && b.products && b.products.length > 0;
  const pendingProductCount =
    b.channel === "qvc" &&
    b.product_ids &&
    b.product_ids.length > 0 &&
    (!b.products || b.products.length < b.product_ids.length)
      ? b.product_ids.length - (b.products?.length ?? 0)
      : 0;

  // Slot-level fit analysis: ShopCh slots have a single product per slot;
  // QVC slots may contain multiple products but the program-title slot still
  // represents the "what aired in this minute" question we want analyzed.
  const slotProductName =
    b.channel === "shopch"
      ? (b.description ?? b.program_title)
      : b.program_title;

  const isArchiving =
    !b.archived_video_s3 &&
    (b.video_status === "queued" || b.video_status === "downloading");
  const hasArchive = !!b.archived_video_s3;

  return (
    <div className="p-3 border border-border rounded-lg hover:bg-muted/60 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {b.channel === "shopch" ? <ShopchHeader b={b} /> : <QvcHeader b={b} />}
          {b.channel === "qvc" && b.description && (
            <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{b.description}</div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 self-start mt-1">
          {hasArchive && (
            <button
              type="button"
              title={t("playArchive")}
              onClick={(e) => { e.stopPropagation(); onPlayVideo?.(b); }}
              className="flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-800 dark:hover:text-emerald-300 transition-colors"
            >
              <Play size={14} />
            </button>
          )}
          {isArchiving && (
            <span
              title={t("archiving")}
              className="flex items-center gap-1 text-xs text-amber-500"
            >
              <Loader2 size={14} className="animate-spin" />
            </span>
          )}
          <a
            href={b.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 dark:hover:text-blue-300"
          >
            <ExternalLink size={12} />
            {t("openSource")}
          </a>
        </div>
      </div>
      {hasProducts && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {b.products!.map((p) => (
            <ProductCard key={p.id} p={p} />
          ))}
          {pendingProductCount > 0 && (
            <div className="text-[10px] text-muted-foreground italic sm:col-span-2">
              ({pendingProductCount} 件の商品情報が未取得 — enrich:qvc-products 実行待ち)
            </div>
          )}
        </div>
      )}
      <div className="mt-2">
        <CompetitorFitPanel
          slot={{
            channel: b.channel,
            productName: slotProductName,
            category: b.category ?? null,
            priceText: b.channel === "qvc" && b.products && b.products[0]?.price_text
              ? b.products[0].price_text
              : null,
            airDate: b.air_date,
            startTime: b.start_time ?? null,
            description: b.description,
            sourceUrl: b.source_url,
          }}
        />
      </div>
    </div>
  );
}
