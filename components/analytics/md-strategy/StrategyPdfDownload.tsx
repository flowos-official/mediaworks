'use client';

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

export default function StrategyPdfDownload() {
	const [loading, setLoading] = useState(false);

	const handleDownload = async () => {
		setLoading(true);
		try {
			const { default: html2canvas } = await import('html2canvas');
			const { default: jsPDF } = await import('jspdf');

			const element = document.getElementById('md-strategy-content');
			if (!element) return;

			const canvas = await html2canvas(element, {
				scale: 2,
				useCORS: true,
				backgroundColor: '#ffffff',
				logging: false,
			});

			const imgData = canvas.toDataURL('image/png');
			const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

			const pageWidth = pdf.internal.pageSize.getWidth();
			const pageHeight = pdf.internal.pageSize.getHeight();
			const imgWidth = pageWidth;
			const imgHeight = (canvas.height * pageWidth) / canvas.width;
			let heightLeft = imgHeight;
			let position = 0;

			pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
			heightLeft -= pageHeight;

			while (heightLeft > 0) {
				position = heightLeft - imgHeight;
				pdf.addPage();
				pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
				heightLeft -= pageHeight;
			}

			const date = new Date().toISOString().slice(0, 10);
			pdf.save(`mediaworks-md-strategy-${date}.pdf`);
		} catch (err) {
			console.error('PDF generation failed:', err);
		} finally {
			setLoading(false);
		}
	};

	return (
		<button
			type="button"
			onClick={handleDownload}
			disabled={loading}
			className="flex items-center gap-2 px-4 py-2 bg-gray-900 hover:bg-gray-800 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
		>
			{loading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
			{loading ? 'PDF生成中...' : 'PDF戦略書ダウンロード'}
		</button>
	);
}
