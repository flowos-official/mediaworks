'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ImageIcon, Search, X, Loader2, ChevronLeft, ChevronRight,
} from 'lucide-react';

type GalleryProduct = {
  code: string;
  name: string;
  category: string | null;
  thumbnail: string;
  imageCount: number;
};

type ProductImage = {
  id: string;
  sheet_name: string | null;
  s3_url: string;
  mime_type: string;
  sort_order: number;
};

export default function GalleryPage() {
  const t = useTranslations('gallery');

  // Gallery state
  const [products, setProducts] = useState<GalleryProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [listError, setListError] = useState<string | null>(null);

  // Detail view state
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [selectedImages, setSelectedImages] = useState<ProductImage[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxRef = useRef<HTMLDivElement | null>(null);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/analytics/gallery${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setProducts(data.products ?? []);
    } catch {
      setProducts([]);
      setListError(t('loadError'));
    } finally {
      setLoading(false);
    }
  }, [search, t]);

  useEffect(() => {
    const timer = setTimeout(fetchProducts, 300);
    return () => clearTimeout(timer);
  }, [fetchProducts]);

  const openProduct = async (code: string) => {
    setSelectedCode(code);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await fetch(`/api/analytics/products/${code}/images`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSelectedImages(data.images ?? []);
    } catch {
      setSelectedImages([]);
      setDetailError(t('loadError'));
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    if (lightboxIndex !== null) {
      lightboxRef.current?.focus();
    }
  }, [lightboxIndex]);

  // Detail view for a selected product
  if (selectedCode) {
    const product = products.find((p) => p.code === selectedCode);
    // Flat list for lightbox navigation
    const allImages = selectedImages;
    const grouped = new Map<string, { img: ProductImage; flatIndex: number }[]>();
    for (let fi = 0; fi < allImages.length; fi++) {
      const img = allImages[fi];
      const key = img.sheet_name ?? '未分類';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push({ img, flatIndex: fi });
    }

    const lightboxAlt = product?.name ?? selectedCode;

    return (
      <>
          <button
            type="button"
            onClick={() => { setSelectedCode(null); setSelectedImages([]); setDetailError(null); }}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-4"
          >
            <ChevronLeft size={16} /> {t('backToList')}
          </button>

          <div className="mb-6">
            <h2 className="text-xl font-bold text-gray-900">{product?.name ?? selectedCode}</h2>
            <div className="flex items-center gap-2 mt-1">
              {product?.category && <Badge variant="secondary" className="text-[10px]">{product.category}</Badge>}
              <span className="text-xs text-gray-400 font-mono">{selectedCode}</span>
            </div>
          </div>

          {detailLoading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-blue-600" />
            </div>
          )}

          {!detailLoading && detailError && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
            >
              {detailError}
            </div>
          )}

          {!detailLoading && !detailError && selectedImages.length === 0 && (
            <div className="text-center py-16 text-gray-400">{t('noImages')}</div>
          )}

          {!detailLoading && selectedImages.length > 0 && (
            <div className="space-y-6">
              {Array.from(grouped.entries()).map(([sheetName, items]) => (
                <Card key={sheetName} className="border-gray-200">
                  <CardContent className="pt-4">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-1.5">
                      <ImageIcon size={14} /> {sheetName}
                      <span className="text-xs font-normal text-gray-400">({items.length}{t('images')})</span>
                    </h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      {items.map(({ img, flatIndex }) => (
                        <button
                          key={img.id}
                          type="button"
                          onClick={() => setLightboxIndex(flatIndex)}
                          className="relative aspect-square rounded-lg overflow-hidden border border-gray-200 hover:border-blue-400 hover:shadow-md transition-all bg-gray-50 cursor-pointer"
                        >
                          <Image
                            src={img.s3_url}
                            alt={lightboxAlt}
                            fill
                            sizes="(max-width: 768px) 50vw, 25vw"
                            className="object-contain"
                            loading="lazy"
                            unoptimized
                          />
                        </button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Lightbox with prev/next */}
          {lightboxIndex !== null && allImages[lightboxIndex] && (
            <div
              ref={lightboxRef}
              role="dialog"
              aria-modal="true"
              aria-label={t('lightboxLabel')}
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 outline-none"
              onClick={() => setLightboxIndex(null)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' && lightboxIndex > 0) setLightboxIndex(lightboxIndex - 1);
                if (e.key === 'ArrowRight' && lightboxIndex < allImages.length - 1) setLightboxIndex(lightboxIndex + 1);
                if (e.key === 'Escape') setLightboxIndex(null);
              }}
              tabIndex={-1}
            >
              {/* Close button */}
              <button
                type="button"
                aria-label={t('lightboxClose')}
                onClick={() => setLightboxIndex(null)}
                className="absolute top-4 right-4 bg-white/90 rounded-full p-1.5 shadow-lg hover:bg-white z-10"
              >
                <X size={18} />
              </button>

              {/* Counter */}
              <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-3 py-1 rounded-full">
                {lightboxIndex + 1} / {allImages.length}
              </div>

              {/* Previous button */}
              {lightboxIndex > 0 && (
                <button
                  type="button"
                  aria-label={t('lightboxPrev')}
                  onClick={(e) => { e.stopPropagation(); setLightboxIndex(lightboxIndex - 1); }}
                  className="absolute left-3 top-1/2 -translate-y-1/2 bg-white/90 rounded-full p-2 shadow-lg hover:bg-white z-10"
                >
                  <ChevronLeft size={20} />
                </button>
              )}

              {/* Image */}
              <div
                className="relative w-[85vw] h-[85vh]"
                onClick={(e) => e.stopPropagation()}
              >
                <Image
                  src={allImages[lightboxIndex].s3_url}
                  alt={lightboxAlt}
                  fill
                  sizes="85vw"
                  className="object-contain rounded-lg shadow-2xl"
                  priority
                  unoptimized
                />
              </div>

              {/* Next button */}
              {lightboxIndex < allImages.length - 1 && (
                <button
                  type="button"
                  aria-label={t('lightboxNext')}
                  onClick={(e) => { e.stopPropagation(); setLightboxIndex(lightboxIndex + 1); }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 bg-white/90 rounded-full p-2 shadow-lg hover:bg-white z-10"
                >
                  <ChevronRight size={20} />
                </button>
              )}
            </div>
          )}
        </>
    );
  }

  // Main gallery grid
  return (
    <>
        {/* Search */}
        <div className="relative mb-6">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="w-full pl-9 pr-4 py-2.5 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
          />
        </div>

        {!loading && listError && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
          >
            {listError}
          </div>
        )}

        {/* Product Grid */}
        {loading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-blue-600" />
          </div>
        )}

        {!loading && !listError && products.length === 0 && (
          <div className="text-center py-16 text-gray-400">{t('noImages')}</div>
        )}

        {!loading && products.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {products.map((product) => (
              <button
                key={product.code}
                type="button"
                onClick={() => openProduct(product.code)}
                className="text-left group"
              >
                <div className="relative aspect-square rounded-xl overflow-hidden border border-gray-200 bg-white group-hover:border-blue-400 group-hover:shadow-lg transition-all">
                  <Image
                    src={product.thumbnail}
                    alt={product.name}
                    fill
                    sizes="(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 25vw"
                    className="object-contain p-2"
                    loading="lazy"
                    unoptimized
                  />
                </div>
                <div className="mt-2 px-1">
                  <h3 className="text-sm font-medium text-gray-900 line-clamp-2">{product.name}</h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    {product.category && <Badge variant="secondary" className="text-[9px]">{product.category}</Badge>}
                    <span className="text-[10px] text-gray-400">{product.imageCount}{t('images')}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

      </>
  );
}
