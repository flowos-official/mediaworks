"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { X, ShoppingBag } from "lucide-react";
import { useDialogBehavior } from "@/components/ui/use-dialog-behavior";

interface BroadcastProduct {
  product_id: string;
  position: number;
  name: string | null;
  image_url: string | null;
  price_jpy: number | null;
  original_price_jpy: number | null;
  discount_rate: number | null;
  sale_label: string | null;
  tax_incl: boolean | null;
  in_stock_at_capture: boolean | null;
  source: string;
  captured_at: string;
}

interface Props {
  broadcastId: string | null;
  videoKey: string | null;
  brandName: string | null;
  onClose: () => void;
}

type ProductLoadState = {
  broadcastId: string | null;
  products: BroadcastProduct[];
};

function formatJpy(n: number): string {
  return `¥${n.toLocaleString("ja-JP")}`;
}

export default function BroadcastVideoModal({
  broadcastId,
  videoKey,
  brandName,
  onClose,
}: Props) {
  const t = useTranslations("broadcasts");
  const [productState, setProductState] = useState<ProductLoadState>({
    broadcastId: null,
    products: [],
  });
  const dialogRef = useRef<HTMLDivElement>(null);

  const isOpen = !!(broadcastId && videoKey);
  const archiveBaseUrl = process.env.NEXT_PUBLIC_VIDEO_ARCHIVE_BASE_URL;
  const videoUrl = archiveBaseUrl && videoKey
    ? `${archiveBaseUrl.replace(/\/$/, "")}/${videoKey.replace(/^\//, "")}`
    : null;
  const hasCurrentProducts = isOpen && productState.broadcastId === broadcastId;
  const products = hasCurrentProducts ? productState.products : [];
  const loading = isOpen && !hasCurrentProducts;

  useDialogBehavior(isOpen, onClose, dialogRef);

  // Fetch products for this broadcast
  useEffect(() => {
    if (!isOpen || !broadcastId) return;
    const ctrl = new AbortController();
    fetch(`/api/broadcasts/${broadcastId}/products`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((json: { products: BroadcastProduct[] }) => {
        setProductState({ broadcastId, products: json.products ?? [] });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) {
          setProductState({ broadcastId, products: [] });
        }
      });
    return () => ctrl.abort();
  }, [isOpen, broadcastId]);

  // Early return after all hooks
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="broadcast-video-title"
        tabIndex={-1}
        className="relative w-full max-w-3xl max-h-[90dvh] overflow-y-auto bg-card rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div>
            <h2 id="broadcast-video-title" className="text-base font-semibold text-foreground">
              {t("archivedBroadcast")}
            </h2>
            {brandName && (
              <p className="text-xs text-muted-foreground mt-0.5">{brandName}</p>
            )}
          </div>
          <button
            data-dialog-autofocus
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Video */}
        <div className="px-5 pt-4 flex-shrink-0">
          {/*
            preload="none" (not "metadata"): archived videos are fragmented MP4
            (ffmpeg empty_moov, no mehd, mvhd duration=0 — see lib/broadcasts/
            video-archival.ts). ShopCh programs are ~1hr ≈ 1.2GB, so "metadata"
            makes the browser fire hundreds of range requests hunting fragments
            to compute duration and never settle → perpetual spinner. QVC's
            ~40MB files mask it. "none" stays idle until the user clicks play,
            then streams sequentially. Verified 2026-06-03.
          */}
          {videoUrl ? (
            <video
              key={videoUrl}
              controls
              preload="none"
              className="w-full rounded-lg bg-black aspect-video"
            >
              <source src={videoUrl} />
            </video>
          ) : (
            <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-border bg-muted px-4 text-center text-sm text-muted-foreground">
              {t("videoArchiveNotConfigured")}
            </div>
          )}
        </div>

        {/* Product list */}
        <div className="px-5 py-4">
          <h3 className="text-sm font-medium text-foreground mb-3">
            {loading
              ? t("loading")
              : t("productsInBroadcast", { n: products.length })}
          </h3>
          {!loading && products.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {products.map((p) => (
                <div
                  key={p.product_id}
                  className="flex gap-3 p-2.5 rounded-lg border border-border bg-muted"
                >
                  {p.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.image_url}
                      alt=""
                      className="w-16 h-16 object-cover rounded flex-shrink-0 bg-accent"
                      loading="lazy"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.visibility =
                          "hidden";
                      }}
                    />
                  ) : (
                    <div className="w-16 h-16 bg-accent text-muted-foreground rounded flex-shrink-0 flex items-center justify-center">
                      <ShoppingBag size={18} strokeWidth={1.5} />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-foreground line-clamp-2 leading-tight">
                      {p.name ?? `#${p.product_id}`}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      {p.price_jpy != null && (
                        <span className="text-xs font-mono text-foreground">
                          {formatJpy(p.price_jpy)}
                        </span>
                      )}
                      {p.original_price_jpy != null &&
                        p.price_jpy != null &&
                        p.original_price_jpy > p.price_jpy && (
                          <span className="text-[10px] text-muted-foreground line-through font-mono">
                            {formatJpy(p.original_price_jpy)}
                          </span>
                        )}
                      {p.discount_rate != null && p.discount_rate > 0 && (
                        <span className="text-[10px] bg-red-600/15 text-red-700 dark:text-red-300 px-1 rounded font-medium">
                          -{p.discount_rate}%
                        </span>
                      )}
                      {p.in_stock_at_capture === false && (
                        <span className="text-[10px] bg-accent text-muted-foreground px-1 rounded">
                          {t("soldOut")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
