import { useTranslations } from "next-intl";
import { ExternalLink, ShoppingBag, PlayCircle } from "lucide-react";
import ChannelBadge from "./ChannelBadge";

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
}

interface Props {
  broadcast: Broadcast;
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
  shopch: "bg-red-50 text-red-400",
  qvc: "bg-violet-50 text-violet-400",
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
          className="w-20 h-20 object-cover rounded flex-shrink-0 bg-gray-100"
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
          <span className="font-mono font-semibold text-gray-700">{formatTime(b.start_time)}</span>
          <ChannelBadge channel={b.channel} />
          {b.presenter && (
            <span className="text-gray-400 truncate max-w-[12rem]">· {b.presenter}</span>
          )}
        </div>
        <div className="font-semibold text-gray-900 mt-1 text-base line-clamp-2 leading-snug">
          {productName}
        </div>
        {context && (
          <div className="text-xs text-gray-500 mt-1 truncate">{context}</div>
        )}
      </div>
    </div>
  );
}

function QvcHeader({ b }: { b: Broadcast }) {
  return (
    <div className="flex items-center gap-2 text-xs flex-wrap">
      <span className="font-mono font-semibold text-gray-700">{formatTime(b.start_time)}</span>
      <ChannelBadge channel={b.channel} />
      <span className="font-semibold text-sm text-gray-900 truncate max-w-[28rem]">
        {b.program_title}
      </span>
      {b.presenter && (
        <span className="text-gray-400 truncate max-w-[10rem]">· {b.presenter}</span>
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
      className="group flex gap-2 p-2 rounded border border-gray-200 bg-white hover:border-violet-300 hover:bg-violet-50/40 transition-colors"
    >
      {p.image_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={p.image_url}
          alt=""
          className="w-16 h-16 object-cover rounded flex-shrink-0 bg-gray-100"
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).style.visibility = "hidden";
          }}
        />
      ) : (
        <div className="w-16 h-16 bg-violet-50 text-violet-400 rounded flex-shrink-0 flex items-center justify-center">
          <ShoppingBag size={20} strokeWidth={1.5} />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-gray-900 line-clamp-2 leading-tight group-hover:text-violet-800">
          {p.name ?? `Product #${p.id}`}
        </div>
        <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-500">
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

export default function BroadcastListItem({ broadcast }: Props) {
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

  return (
    <div className="p-3 border border-gray-200 rounded-lg hover:bg-gray-50/60 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {b.channel === "shopch" ? <ShopchHeader b={b} /> : <QvcHeader b={b} />}
          {b.channel === "qvc" && b.description && (
            <div className="text-xs text-gray-500 mt-1 line-clamp-2">{b.description}</div>
          )}
        </div>
        <a
          href={b.source_url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 flex-shrink-0 self-start mt-1"
        >
          <ExternalLink size={12} />
          {t("openSource")}
        </a>
      </div>
      {hasProducts && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {b.products!.map((p) => (
            <ProductCard key={p.id} p={p} />
          ))}
          {pendingProductCount > 0 && (
            <div className="text-[10px] text-gray-400 italic sm:col-span-2">
              ({pendingProductCount} 件の商品情報が未取得 — enrich:qvc-products 実行待ち)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
