'use client';

import dynamic from 'next/dynamic';
import Navbar from '@/components/Navbar';
import { BarChart3 } from 'lucide-react';

const AnalyticsDashboard = dynamic(
  () => import('@/components/analytics/AnalyticsDashboard'),
  { ssr: false },
);

export default function AnalyticsPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Navbar />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 size={20} className="text-blue-600" />
            <h1 className="text-2xl font-bold text-gray-900">売上分析</h1>
          </div>
          <p className="text-sm text-gray-500">TXDレギュラー受注データに基づく販売実績分析</p>
        </div>
        <AnalyticsDashboard />
      </main>
    </div>
  );
}
