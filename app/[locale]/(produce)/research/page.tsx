'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import FileUpload from '@/components/FileUpload';
import ProductList from '@/components/ProductList';

export default function ResearchPage() {
  const t = useTranslations('home');
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const handleUploadComplete = () => {
    setRefreshTrigger((n) => n + 1);
  };

  return (
    <>
      <div className="max-w-2xl mx-auto">
        <FileUpload onUploadComplete={handleUploadComplete} />
      </div>

      <section>
        <h2 className="text-xl font-semibold text-gray-900 mb-6">{t('recentProducts')}</h2>
        <ProductList refreshTrigger={refreshTrigger} />
      </section>
    </>
  );
}
