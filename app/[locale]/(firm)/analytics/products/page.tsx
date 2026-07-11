'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader2, FileSpreadsheet, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import TopProductsTable from '@/components/analytics/TopProductsTable';
import ProductDetailModal from '@/components/analytics/ProductDetailModal';
import { useAnalyticsFilter } from '@/lib/analytics/firm-filter-context';
import { useDialogBehavior } from '@/components/ui/use-dialog-behavior';

export default function ProductsPage() {
  const tg = useTranslations('gallery');
  const tc = useTranslations('common');
  const { selectedYears } = useAnalyticsFilter();
  const yearParam = selectedYears.join(',');

  const [products, setProducts] = useState<{ products: unknown[]; total: number; viewer?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<string | null>(null);

  // Taicho upload state
  const [showTaicho, setShowTaicho] = useState(false);
  const [taichoCode, setTaichoCode] = useState('');
  const [taichoFile, setTaichoFile] = useState<File | null>(null);
  const [taichoUploading, setTaichoUploading] = useState(false);
  const [taichoResult, setTaichoResult] = useState<string | null>(null);
  const taichoDialogRef = useRef<HTMLDivElement>(null);
  useDialogBehavior(showTaicho, () => { setShowTaicho(false); setTaichoResult(null); }, taichoDialogRef);

  const fetchData = useCallback(async (signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/analytics/products?year=${yearParam}&limit=500`, { signal });
      if (!res.ok) throw new Error('Failed to fetch products');
      const data = await res.json();
      if (signal.aborted) return;
      setProducts(data);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, [yearParam]);

  useEffect(() => {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => void fetchData(ctrl.signal), 0);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [fetchData]);

  const handleTaichoUpload = async () => {
    if (!taichoFile || !taichoCode.trim()) return;
    setTaichoUploading(true);
    setTaichoResult(null);
    try {
      const form = new FormData();
      form.append('file', taichoFile);
      form.append('product_code', taichoCode.trim());
      const res = await fetch('/api/products/upload-taicho', { method: 'POST', body: form });
      const data = await res.json();
      if (res.ok) {
        setTaichoResult(`${tg('uploadSuccess')} — ${data.imagesUploaded}${tg('images')}`);
        setTaichoCode('');
        setTaichoFile(null);
        // M7: refresh the products list so newly uploaded images appear immediately
        fetchData(new AbortController().signal);
      } else {
        setTaichoResult(data.error ?? tg('uploadError'));
      }
    } catch {
      setTaichoResult(tg('uploadError'));
    } finally {
      setTaichoUploading(false);
    }
  };

  return (
    <>
      {error && (
        <div className="p-4 bg-red-600/10 border border-red-200 dark:border-red-900/40 rounded-lg text-sm text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-600" />
          <span className="ml-2 text-sm text-muted-foreground">{tc('loading')}</span>
        </div>
      )}

      {!loading && products && (
        <div className="space-y-6">
          {!products.viewer && (
            <button
              type="button"
              onClick={() => setShowTaicho(true)}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-border rounded-xl text-sm text-muted-foreground hover:border-blue-400 hover:text-blue-600 transition-colors"
            >
              <FileSpreadsheet size={16} />
              {tg('uploadButton')} (.xlsx / .xlsm)
            </button>
          )}
          <TopProductsTable
            products={(products.products as Parameters<typeof TopProductsTable>[0]['products'])}
            onSelectProduct={setSelectedProduct}
          />
        </div>
      )}

      {showTaicho && !products?.viewer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => { setShowTaicho(false); setTaichoResult(null); }}
          />
          <div ref={taichoDialogRef} role="dialog" aria-modal="true" aria-labelledby="taicho-upload-title" tabIndex={-1} className="relative bg-card rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 id="taicho-upload-title" className="text-lg font-bold text-foreground">{tg('uploadTitle')}</h2>
              <button
                data-dialog-autofocus
                type="button"
                aria-label={tc('close')}
                onClick={() => { setShowTaicho(false); setTaichoResult(null); }}
                className="p-1.5 hover:bg-muted rounded-lg"
              >
                <X size={18} className="text-muted-foreground" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{tg('uploadDescription')}</p>
            <div className="space-y-4">
              <div>
                <label htmlFor="taicho-product-code" className="block text-sm font-medium text-foreground mb-1">{tg('productCode')}</label>
                <input
                  id="taicho-product-code"
                  type="text"
                  value={taichoCode}
                  onChange={(e) => setTaichoCode(e.target.value)}
                  placeholder={tg('productCodePlaceholder')}
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label htmlFor="taicho-file" className="block text-sm font-medium text-foreground mb-1">{tg('selectFile')}</label>
                <input
                  id="taicho-file"
                  type="file"
                  accept=".xlsx,.xlsm"
                  onChange={(e) => setTaichoFile(e.target.files?.[0] ?? null)}
                  className="w-full text-sm text-muted-foreground file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-blue-600/10 file:text-blue-700 hover:file:bg-blue-600/15"
                />
              </div>
              {taichoResult && (
                <div className={`text-sm p-3 rounded-lg ${taichoResult.includes(tg('uploadSuccess')) ? 'bg-green-600/10 text-green-700 dark:text-green-300' : 'bg-red-600/10 text-red-700 dark:text-red-300'}`}>
                  {taichoResult}
                </div>
              )}
              <button
                type="button"
                onClick={handleTaichoUpload}
                disabled={taichoUploading || !taichoFile || !taichoCode.trim()}
                className="w-full py-2.5 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {taichoUploading && <Loader2 size={14} className="animate-spin" />}
                {taichoUploading ? tg('uploading') : tg('uploadButton')}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedProduct && (
        <ProductDetailModal
          productCode={selectedProduct}
          years={selectedYears}
          onClose={() => setSelectedProduct(null)}
        />
      )}
    </>
  );
}
