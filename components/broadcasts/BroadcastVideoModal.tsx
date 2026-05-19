"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { X, ShoppingBag } from "lucide-react";

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

const R2_BASE = process.env.NEXT_PUBLIC_R2_PUBLIC_BASE_URL ?? "";

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
  const [products, setProducts] = useState<BroadcastProduct[]>([]);
  const [loading, setLoading] = useState(false);

  const isOpen = !!(broadcastId && videoKey);
  const videoUrl = `${R2_BASE}/${videoKey ?? ""}`;

  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

  // Fetch products for this broadcast
  useEffect(() => {
    if (!isOpen || !broadcastId) return;
    setProducts([]);
    setLoading(true);
    fetch(`/api/broadcasts/${broadcastId}/products`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((json: { products: BroadcastProduct[] }) => {
        setProducts(json.products ?? []);
      })
      .catch(() => {
        setProducts([]);
      })
      .finally(() => setLoading(false));
  }, [isOpen, broadcastId]);

  // Early return after all hooks
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-3xl max-h-[90dvh] overflow-y-auto bg-white rounded-xl shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-gray-900">
              {t("archivedBroadcast")}
            </h2>
            {brandName && (
              <p className="text-xs text-gray-500 mt-0.5">{brandName}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 transition-colors"
            aria-label="Close"
          >
            <X size={20} />
          </button>
        </div>

        {/* Video */}
        <div className="px-5 pt-4 flex-shrink-0">
          <video
            key={videoUrl}
            controls
            preload="metadata"
            className="w-full rounded-lg bg-black aspect-video"
          >
            <source src={videoUrl} />
          </video>
        </div>

        {/* Product list */}
        <div className="px-5 py-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">
            {loading
              ? t("loading")
              : t("productsInBroadcast", { n: products.length })}
          </h3>
          {!loading && products.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {products.map((p) => (
                <div
                  key={p.product_id}
                  className="flex gap-3 p-2.5 rounded-lg border border-gray-200 bg-gray-50"
                >
                  {p.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.image_url}
                      alt=""
                      className="w-16 h-16 object-cover rounded flex-shrink-0 bg-gray-200"
                      loading="lazy"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.visibility =
                          "hidden";
                      }}
                    />
                  ) : (
                    <div className="w-16 h-16 bg-gray-200 text-gray-400 rounded flex-shrink-0 flex items-center justify-center">
                      <ShoppingBag size={18} strokeWidth={1.5} />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold text-gray-900 line-clamp-2 leading-tight">
                      {p.name ?? `#${p.product_id}`}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1">
                      {p.price_jpy != null && (
                        <span className="text-xs font-mono text-gray-800">
                          {formatJpy(p.price_jpy)}
                        </span>
                      )}
                      {p.original_price_jpy != null &&
                        p.price_jpy != null &&
                        p.original_price_jpy > p.price_jpy && (
                          <span className="text-[10px] text-gray-400 line-through font-mono">
                            {formatJpy(p.original_price_jpy)}
                          </span>
                        )}
                      {p.discount_rate != null && p.discount_rate > 0 && (
                        <span className="text-[10px] bg-red-100 text-red-700 px-1 rounded font-medium">
                          -{p.discount_rate}%
                        </span>
                      )}
                      {p.in_stock_at_capture === false && (
                        <span className="text-[10px] bg-gray-200 text-gray-500 px-1 rounded">
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
