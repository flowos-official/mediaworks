'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Loader2 } from 'lucide-react';
import { Product, ResearchResult } from '@/lib/supabase';

interface Props {
  product: Product;
  research: ResearchResult;
}

export default function PdfDownload({ product, research }: Props) {
  const t = useTranslations('report');
  const [loading, setLoading] = useState(false);

  const handleDownload = async () => {
    setLoading(true);
    const reportEl = document.getElementById('report-content');

    try {
      const { default: html2canvas } = await import('html2canvas-pro');
      const { default: jsPDF } = await import('jspdf');

      if (!reportEl) return;

      // 1. Enter PDF mode — reveals all hidden tab/accordion content
      reportEl.classList.add('pdf-mode');
      await new Promise((r) => setTimeout(r, 150));

      // 2. PDF setup
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 8;
      const usableWidth = pageWidth - margin * 2;
      const usableHeight = pageHeight - margin * 2;

      // 3. Get all direct children (report sections)
      const sections = Array.from(reportEl.children).filter(
        (el): el is HTMLElement => el instanceof HTMLElement
      );

      let currentY = margin;
      let needsNewPage = false;

      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];

        // Capture this section
        const canvas = await html2canvas(section, {
          scale: 2,
          useCORS: true,
          backgroundColor: '#ffffff',
          logging: false,
        });

        const imgWidthPx = canvas.width;
        const imgHeightPx = canvas.height;
        const sectionHeightMm = (imgHeightPx * usableWidth) / imgWidthPx;

        if (sectionHeightMm <= 0) continue;

        const spaceLeft = pageHeight - margin - currentY;

        if (sectionHeightMm <= usableHeight) {
          // Section fits on a single page
          if (sectionHeightMm > spaceLeft || needsNewPage) {
            // Not enough space on current page — start new page
            if (i > 0) pdf.addPage();
            currentY = margin;
            needsNewPage = false;
          }

          pdf.addImage(
            canvas.toDataURL('image/png'),
            'PNG',
            margin,
            currentY,
            usableWidth,
            sectionHeightMm
          );
          currentY += sectionHeightMm + 3;
        } else {
          // Section is taller than one page — need to split
          if (currentY > margin + 1) {
            pdf.addPage();
            currentY = margin;
          }

          const pxPerMm = imgHeightPx / sectionHeightMm;
          let remainingMm = sectionHeightMm;
          let srcY = 0;

          while (remainingMm > 0) {
            const sliceMm = Math.min(remainingMm, usableHeight);
            const slicePx = Math.ceil(sliceMm * pxPerMm);

            // Create a sliced canvas for this page
            const sliceCanvas = document.createElement('canvas');
            sliceCanvas.width = imgWidthPx;
            sliceCanvas.height = slicePx;
            const ctx = sliceCanvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(
                canvas,
                0, srcY, imgWidthPx, slicePx,
                0, 0, imgWidthPx, slicePx
              );
            }

            if (srcY > 0) {
              pdf.addPage();
              currentY = margin;
            }

            pdf.addImage(
              sliceCanvas.toDataURL('image/png'),
              'PNG',
              margin,
              currentY,
              usableWidth,
              sliceMm
            );

            srcY += slicePx;
            remainingMm -= sliceMm;
            currentY = margin + sliceMm + 3;
          }
        }
      }

      // 4. Exit PDF mode
      reportEl.classList.remove('pdf-mode');

      pdf.save(`mediaworks-${product.name}-report.pdf`);
    } catch (err) {
      console.error('PDF generation failed:', err);
      reportEl?.classList.remove('pdf-mode');
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleDownload}
      disabled={loading}
      className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium px-5 py-2.5 rounded-lg transition-colors"
    >
      {loading ? (
        <Loader2 size={16} className="animate-spin" />
      ) : (
        <Download size={16} />
      )}
      {t('downloadPdf')}
    </button>
  );
}
