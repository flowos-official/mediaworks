'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Package } from 'lucide-react';
import ProductCard from './ProductCard';
import { Product } from '@/lib/supabase';

interface ProductListProps {
  refreshTrigger: number;
}

export default function ProductList({ refreshTrigger }: ProductListProps) {
  const t = useTranslations('home');
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

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
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </div>
  );
}
