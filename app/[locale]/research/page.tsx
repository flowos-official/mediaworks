// app/[locale]/research/page.tsx
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import FileUpload from '@/components/FileUpload';
import ProductList from '@/components/ProductList';
import { Sparkles } from 'lucide-react';

export default function ResearchPage() {
  const t = useTranslations('home');
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleUploadComplete = () => {
    setRefreshTrigger((n) => n + 1);
  };

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-2 bg-blue-50 text-blue-700 text-sm font-medium px-4 py-2 rounded-full mb-4">
          <Sparkles size={14} />
          AI-Powered Research
        </div>
        <h1 className="text-4xl font-bold text-gray-900 mb-3">{t('title')}</h1>
        <p className="text-lg text-gray-500 max-w-2xl mx-auto">{t('description')}</p>
      </div>

      <div className="max-w-2xl mx-auto mb-16">
        <FileUpload onUploadComplete={handleUploadComplete} />
      </div>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-6">{t('recentProducts')}</h2>
        <ProductList refreshTrigger={refreshTrigger} />
      </section>
    </main>
  );
}
