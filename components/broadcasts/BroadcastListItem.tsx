import { useState } from "react";
import { useTranslations } from "next-intl";
import { ExternalLink, ShoppingBag, PlayCircle, X } from "lucide-react";
import ChannelBadge from "./ChannelBadge";

export interface QvcProduct {
  id: string;
  name: string | null;
  description: string | null;
  image_url: string | null;
  video_url: string | null;
  price_text: string | null;
  source_url: string;
  archived_thumbnail_s3?: string | null;
  archived_video_s3?: string | null;
}

export interface ShopchProduct {
  id: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  price_jpy: number | null;
  compare_price_jpy: number | null;
  off_rate: number | null;
  image_url: string | null;
  source_url: string;
  archived_thumbnail_s3?: string | null;
}

export type AnyProduct = QvcProduct | ShopchProduct;

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
  products?: AnyProduct[] | null;
  archived_video_s3?: string | null;
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

function isQvc(p: AnyProduct): p is QvcProduct {
  return "video_url" in p;
}

function ProductCard({ p, onPlayVideo }: { p: AnyProduct; onPlayVideo: (url: string, title: string) => void }) {
  const qvc = isQvc(p);
  const archivedVideo = qvc ? p.archived_video_s3 ?? null : null;
  const playableUrl = archivedVideo; // Only archived videos are playable inline today
  const thumb = (qvc ? p.archived_thumbnail_s3 : p.archived_thumbnail_s3) ?? p.image_url;
  const priceText = qvc
    ? p.price_text
    : p.price_jpy
    ? `¥${p.price_jpy.toLocaleString()}`
    : null;

  return (
    <div className="group flex gap-2 p-2 rounded border border-gray-200 bg-white hover:border-violet-300 hover:bg-violet-50/40 transition-colors">
      <a href={p.source_url} target="_blank" rel="noopener noreferrer" className="flex-shrink-0">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumb}
            alt=""
            className="w-16 h-16 object-cover rounded bg-gray-100"
            loading="lazy"
            onError={(e) => {
              (e.target as HTMLImageElement).style.visibility = "hidden";
            }}
          />
        ) : (
          <div className="w-16 h-16 bg-violet-50 text-violet-400 rounded flex items-center justify-center">
            <ShoppingBag size={20} strokeWidth={1.5} />
          </div>
        )}
      </a>
      <div className="flex-1 min-w-0">
        <a href={p.source_url} target="_blank" rel="noopener noreferrer">
          <div className="text-xs font-semibold text-gray-900 line-clamp-2 leading-tight group-hover:text-violet-800">
            {p.name ?? `Product #${p.id}`}
          </div>
        </a>
        <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-500">
          <span className="font-mono">#{p.id}</span>
          {playableUrl && (
            <button
              type="button"
              onClick={() => onPlayVideo(playableUrl, p.name ?? `#${p.id}`)}
              className="inline-flex items-center gap-0.5 text-violet-700 hover:text-violet-900 cursor-pointer"
            >
              <PlayCircle size={11} /> 再生
            </button>
          )}
          {qvc && p.video_url && !playableUrl && (
            <span className="inline-flex items-center gap-0.5 text-gray-400">
              <PlayCircle size={10} /> 動画
            </span>
          )}
          {priceText && <span className="truncate">{priceText}</span>}
        </div>
      </div>
    </div>
  );
}

function VideoModal({
  src,
  title,
  onClose,
}: {
  src: string;
  title: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl bg-black rounded-lg overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute top-2 right-2 z-10 text-white bg-black/50 hover:bg-black/70 rounded-full p-1"
          aria-label="close"
        >
          <X size={18} />
        </button>
        <video src={src} controls autoPlay className="w-full h-auto" preload="metadata" />
        <div className="p-2 text-xs text-white/80 line-clamp-1">{title}</div>
      </div>
    </div>
  );
}

export default function BroadcastListItem({ broadcast }: Props) {
  const t = useTranslations("broadcasts");
  const b = broadcast;
  const [videoModal, setVideoModal] = useState<{ src: string; title: string } | null>(null);
  const hasProducts = b.products && b.products.length > 0;
  const pendingProductCount =
    b.product_ids &&
    b.product_ids.length > 0 &&
    (!b.products || b.products.length < b.product_ids.length)
      ? b.product_ids.length - (b.products?.length ?? 0)
      : 0;
  const slotVideoUrl = b.archived_video_s3 ?? null;

  return (
    <div className="p-3 border border-gray-200 rounded-lg hover:bg-gray-50/60 transition-colors">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          {b.channel === "shopch" ? <ShopchHeader b={b} /> : <QvcHeader b={b} />}
          {b.channel === "qvc" && b.description && (
            <div className="text-xs text-gray-500 mt-1 line-clamp-2">{b.description}</div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 self-start mt-1">
          {slotVideoUrl && (
            <button
              type="button"
              onClick={() => setVideoModal({ src: slotVideoUrl, title: b.program_title })}
              className="flex items-center gap-1 text-xs text-violet-700 hover:text-violet-900"
            >
              <PlayCircle size={13} /> 番組動画
            </button>
          )}
          <a
            href={b.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
          >
            <ExternalLink size={12} />
            {t("openSource")}
          </a>
        </div>
      </div>
      {hasProducts && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {b.products!.map((p) => (
            <ProductCard
              key={p.id}
              p={p}
              onPlayVideo={(src, title) => setVideoModal({ src, title })}
            />
          ))}
          {pendingProductCount > 0 && (
            <div className="text-[10px] text-gray-400 italic sm:col-span-2">
              ({pendingProductCount} 件の商品情報が未取得)
            </div>
          )}
        </div>
      )}
      {videoModal && (
        <VideoModal
          src={videoModal.src}
          title={videoModal.title}
          onClose={() => setVideoModal(null)}
        />
      )}
    </div>
  );
}
