'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Package, Search, X } from 'lucide-react';
import ProductCard from './ProductCard';
import { Product } from '@/lib/supabase';

interface ProductListProps {
  refreshTrigger: number;
}

export default function ProductList({ refreshTrigger }: ProductListProps) {
  const t = useTranslations('home');
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const fetchProducts = useCallback(async () => {
    try {
      const res = await fetch('/api/products');
      const data = await res.json();
      setProducts(data.products || []);
    } catch (err) {
      console.error('Failed to fetch products:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProducts();
  }, [fetchProducts, refreshTrigger]);

  // Auto-refresh if any products are analyzing
  useEffect(() => {
    const hasAnalyzing = products.some(
      (p) => p.status === 'pending' || p.status === 'analyzing'
    );
    if (!hasAnalyzing) return;

    const interval = setInterval(fetchProducts, 5000);
    return () => clearInterval(interval);
  }, [products, fetchProducts]);

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const q = searchQuery.toLowerCase();
      const matchesSearch = !q
        || p.name.toLowerCase().includes(q)
        || (p.description?.toLowerCase().includes(q));
      const matchesStatus = statusFilter === 'all'
        || p.status === statusFilter
        || (statusFilter === 'analyzing' && p.status === 'extracted');
      return matchesSearch && matchesStatus;
    });
  }, [products, searchQuery, statusFilter]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-32 bg-gray-100 rounded-xl animate-pulse" />
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
          <Package size={32} className="text-gray-400" />
        </div>
        <p className="text-gray-500">{t('noProducts')}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('search.placeholder')}
            className="w-full pl-9 pr-9 py-2 text-sm border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
          />
          {searchQuery && (
            <button type="button" onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {(['all', 'completed', 'analyzing', 'pending', 'failed'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                statusFilter === s
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-300'
              }`}
            >
              {s === 'all' ? t('search.allStatuses') : t(`status.${s}` as 'status.completed' | 'status.analyzing' | 'status.pending' | 'status.failed')}
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-gray-400 mb-3">
        {searchQuery || statusFilter !== 'all'
          ? t('search.filteredCount', { filtered: filteredProducts.length, total: products.length })
          : t('search.resultCount', { count: products.length })}
      </p>

      {filteredProducts.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          {t('search.noResults')}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProducts.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}
