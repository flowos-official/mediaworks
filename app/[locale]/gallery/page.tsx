'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import Navbar from '@/components/Navbar';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  ImageIcon, Search, Upload, X, Loader2, ChevronLeft, ChevronRight,
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

  // Detail view state
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [selectedImages, setSelectedImages] = useState<ProductImage[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Upload state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadCode, setUploadCode] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<string | null>(null);

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/analytics/gallery${params}`);
      const data = await res.json();
      setProducts(data.products ?? []);
    } catch {
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const timer = setTimeout(fetchProducts, 300);
    return () => clearTimeout(timer);
  }, [fetchProducts]);

  const openProduct = async (code: string) => {
    setSelectedCode(code);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/analytics/products/${code}/images`);
      const data = await res.json();
      setSelectedImages(data.images ?? []);
    } catch {
      setSelectedImages([]);
    } finally {
      setDetailLoading(false);
    }
  };

  const handleUpload = async () => {
    if (!uploadFile || !uploadCode.trim()) return;
    setUploading(true);
    setUploadResult(null);
    try {
      const form = new FormData();
      form.append('file', uploadFile);
      form.append('product_code', uploadCode.trim());
      const res = await fetch('/api/products/upload-taicho', { method: 'POST', body: form });
      const data = await res.json();
      if (res.ok) {
        setUploadResult(`${t('uploadSuccess')} — ${data.imagesUploaded} ${t('images')}`);
        setUploadCode('');
        setUploadFile(null);
        fetchProducts();
      } else {
        setUploadResult(data.error ?? t('uploadError'));
      }
    } catch {
      setUploadResult(t('uploadError'));
    } finally {
      setUploading(false);
    }
  };

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

    return (
      <div className="min-h-screen bg-gray-50">
        <Navbar />
        <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <button
            type="button"
            onClick={() => { setSelectedCode(null); setSelectedImages([]); }}
            className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900 mb-4"
          >
            <ChevronLeft size={16} /> {t('title')}
          </button>

          <div className="mb-6">
            <h1 className="text-xl font-bold text-gray-900">{product?.name ?? selectedCode}</h1>
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

          {!detailLoading && selectedImages.length === 0 && (
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
                          className="aspect-square rounded-lg overflow-hidden border border-gray-200 hover:border-blue-400 hover:shadow-md transition-all bg-gray-50 cursor-pointer"
                        >
                          <img src={img.s3_url} alt="" className="w-full h-full object-contain" loading="lazy" />
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
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
              onClick={() => setLightboxIndex(null)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' && lightboxIndex > 0) setLightboxIndex(lightboxIndex - 1);
                if (e.key === 'ArrowRight' && lightboxIndex < allImages.length - 1) setLightboxIndex(lightboxIndex + 1);
                if (e.key === 'Escape') setLightboxIndex(null);
              }}
              tabIndex={0}
            >
              {/* Close button */}
              <button
                type="button"
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
                  onClick={(e) => { e.stopPropagation(); setLightboxIndex(lightboxIndex - 1); }}
                  className="absolute left-3 top-1/2 -translate-y-1/2 bg-white/90 rounded-full p-2 shadow-lg hover:bg-white z-10"
                >
                  <ChevronLeft size={20} />
                </button>
              )}

              {/* Image */}
              <img
                src={allImages[lightboxIndex].s3_url}
                alt=""
                className="max-w-[85vw] max-h-[85vh] object-contain rounded-lg shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              />

              {/* Next button */}
              {lightboxIndex < allImages.length - 1 && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setLightboxIndex(lightboxIndex + 1); }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 bg-white/90 rounded-full p-2 shadow-lg hover:bg-white z-10"
                >
                  <ChevronRight size={20} />
                </button>
              )}
            </div>
          )}
        </main>
      </div>
    );
  }

  // Main gallery grid
  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <ImageIcon size={20} className="text-blue-600" />
              <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
            </div>
            <p className="text-sm text-gray-500">{t('subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            <Upload size={14} /> {t('uploadButton')}
          </button>
        </div>

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

        {/* Product Grid */}
        {loading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-blue-600" />
          </div>
        )}

        {!loading && products.length === 0 && (
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
                <div className="aspect-square rounded-xl overflow-hidden border border-gray-200 bg-white group-hover:border-blue-400 group-hover:shadow-lg transition-all">
                  <img src={product.thumbnail} alt={product.name} className="w-full h-full object-contain p-2" loading="lazy" />
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

        {/* Upload Modal */}
        {showUpload && (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40" onClick={() => { setShowUpload(false); setUploadResult(null); }} />
            <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold text-gray-900">{t('uploadTitle')}</h2>
                <button type="button" onClick={() => { setShowUpload(false); setUploadResult(null); }} className="p-1.5 hover:bg-gray-100 rounded-lg">
                  <X size={18} className="text-gray-500" />
                </button>
              </div>
              <p className="text-sm text-gray-500 mb-4">{t('uploadDescription')}</p>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('productCode')}</label>
                  <input
                    type="text"
                    value={uploadCode}
                    onChange={(e) => setUploadCode(e.target.value)}
                    placeholder={t('productCodePlaceholder')}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t('selectFile')}</label>
                  <input
                    type="file"
                    accept=".xlsx,.xlsm"
                    onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                    className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                  />
                </div>

                {uploadResult && (
                  <div className={`text-sm p-3 rounded-lg ${uploadResult.includes(t('uploadSuccess')) ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                    {uploadResult}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleUpload}
                  disabled={uploading || !uploadFile || !uploadCode.trim()}
                  className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {uploading && <Loader2 size={14} className="animate-spin" />}
                  {uploading ? t('uploading') : t('uploadButton')}
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
