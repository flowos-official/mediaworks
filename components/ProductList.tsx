'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Package, Search, X } from 'lucide-react';
import ProductCard from './ProductCard';
import { Product } from '@/lib/supabase';
import { useApiQuery } from '@/lib/client/api-cache';

interface ProductListProps {
  refreshTrigger: number;
}

const EMPTY_PRODUCTS: Product[] = [];

export default function ProductList({ refreshTrigger }: ProductListProps) {
  const t = useTranslations('home');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const { data, isLoading: loading, mutate } = useApiQuery<{ products: Product[] }>('/api/products', {
    refreshInterval: (latest) => {
      const rows = latest?.products ?? [];
      const stillPollable = rows.some((product) => {
        if (product.status !== 'pending' && product.status !== 'analyzing') return false;
        const ageMinutes = (Date.now() - new Date(product.created_at).getTime()) / 60000;
        return ageMinutes < 12;
      });
      return stillPollable ? 5000 : 0;
    },
  });
  const products = data?.products ?? EMPTY_PRODUCTS;

  useEffect(() => {
    if (refreshTrigger > 0) void mutate();
  }, [mutate, refreshTrigger]);

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const q = searchQuery.toLowerCase();
      const matchesSearch = !q
        || p.name.toLowerCase().includes(q)
        || (p.description?.toLowerCase().includes(q));
      const matchesStatus = statusFilter === 'all'
        || p.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [products, searchQuery, statusFilter]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-40 animate-pulse rounded-xl border border-border bg-muted/70" />
        ))}
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="mw-empty-state">
        <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-muted">
          <Package size={20} className="text-muted-foreground" />
        </div>
        <p className="text-muted-foreground">{t('noProducts')}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mw-toolbar mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            aria-label={t('search.placeholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('search.placeholder')}
            className="h-10 w-full rounded-lg border border-border bg-background pl-9 pr-9 text-sm transition focus:border-primary"
          />
          {searchQuery && (
            <button type="button" aria-label={t('search.placeholder')} title={t('search.placeholder')} onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground">
              <X size={14} />
            </button>
          )}
        </div>
        <div className="mw-scrollbar flex gap-1.5 overflow-x-auto sm:flex-wrap">
          {(['all', 'completed', 'analyzing', 'pending', 'failed'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`min-h-9 shrink-0 rounded-lg border px-3 text-xs font-medium transition-colors ${
                statusFilter === s
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:border-primary/30 hover:text-foreground'
              }`}
            >
              {s === 'all' ? t('search.allStatuses') : t(`status.${s}` as 'status.completed' | 'status.analyzing' | 'status.pending' | 'status.failed')}
            </button>
          ))}
        </div>
      </div>

      <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
        {searchQuery || statusFilter !== 'all'
          ? t('search.filteredCount', { filtered: filteredProducts.length, total: products.length })
          : t('search.resultCount', { count: products.length })}
      </p>

      {filteredProducts.length === 0 ? (
        <div className="mw-empty-state">
          {t('search.noResults')}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filteredProducts.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}
