// app/[locale]/analytics/(market)/layout.tsx
import type { ReactNode } from 'react';
import { Globe2 } from 'lucide-react';
import MarketSubNav from '@/components/nav/MarketSubNav';

export default function MarketLayout({ children }: { children: ReactNode }) {
  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Globe2 size={20} className="text-blue-600" />
          <h1 className="text-2xl font-bold text-gray-900">市場リサーチ</h1>
        </div>
        <p className="text-sm text-gray-500">番組カレンダー・新規発掘・MD戦略</p>
      </div>
      <div className="space-y-6">
        <MarketSubNav />
        {children}
      </div>
    </main>
  );
}
