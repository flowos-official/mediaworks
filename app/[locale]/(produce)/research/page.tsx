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
      <FileUpload onUploadComplete={handleUploadComplete} />

      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="mw-kicker mb-1">Research queue</div>
            <h2 className="mw-section-title">{t('recentProducts')}</h2>
          </div>
        </div>
        <ProductList refreshTrigger={refreshTrigger} />
      </section>
    </>
  );
}
