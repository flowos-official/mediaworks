'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';

type ProductRow = {
  code: string;
  name: string;
  category: string | null;
  totalRevenue: number;
  totalProfit: number;
  totalQuantity: number;
  marginRate: number;
  avgWeeklyQuantity: number;
  weekCount: number;
  firstDate?: string | null;
  lastDate?: string | null;
};

type SortKey = 'name' | 'totalRevenue' | 'totalQuantity' | 'marginRate' | 'avgWeeklyQuantity' | 'firstDate';
type SortDir = 'asc' | 'desc';

function formatYen(v: number): string {
  if (v >= 100_000_000) return `¥${(v / 100_000_000).toFixed(1)}億`;
  if (v >= 10_000) return `¥${Math.round(v / 10_000)}万`;
  return `¥${v.toLocaleString()}`;
}

function formatShortDate(d: string | null | undefined): string {
  if (!d) return '-';
  const parts = d.slice(2).split('-'); // "2025-01-06" → ["25","01","06"]
  return `${parts[0]}/${parts[1]}`;
}

export default function TopProductsTable({
  products,
  onSelectProduct,
}: {
  products: ProductRow[];
  onSelectProduct?: (code: string) => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>('totalRevenue');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);
  const perPage = 30;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
    setPage(0);
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown size={11} className="opacity-40" />;
    return sortDir === 'desc' ? <ArrowDown size={11} /> : <ArrowUp size={11} />;
  };

  const sorted = [...products].sort((a, b) => {
    const dir = sortDir === 'desc' ? -1 : 1;
    if (sortKey === 'name') return dir * a.name.localeCompare(b.name, 'ja');
    if (sortKey === 'firstDate') return dir * (a.firstDate ?? '').localeCompare(b.firstDate ?? '');
    return dir * (a[sortKey] - b[sortKey]);
  });
  const totalPages = Math.ceil(sorted.length / perPage);
  const paged = sorted.slice(page * perPage, (page + 1) * perPage);

  return (
    <Card className="border-gray-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-base font-semibold">商品ランキング</CardTitle>
        <p className="text-xs text-gray-400">{products.length}商品</p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase">
                <th className="text-left px-4 py-2.5 font-medium">#</th>
                <th className="text-left px-4 py-2.5 font-medium">
                  <button
                    type="button"
                    onClick={() => toggleSort('name')}
                    className={`flex items-center gap-1 ${sortKey === 'name' ? 'text-blue-600' : ''}`}
                  >
                    商品名 <SortIcon col="name" />
                  </button>
                </th>
                <th className="text-left px-4 py-2.5 font-medium">カテゴリ</th>
                {([
                  { key: 'totalRevenue' as const, label: '売上' },
                  { key: 'totalQuantity' as const, label: '数量' },
                  { key: 'marginRate' as const, label: '粗利率' },
                ]).map((h) => (
                  <th key={h.key} className="text-right px-4 py-2.5 font-medium">
                    <button
                      type="button"
                      onClick={() => toggleSort(h.key)}
                      className={`flex items-center gap-1 ml-auto ${sortKey === h.key ? 'text-blue-600' : ''}`}
                    >
                      {h.label} <SortIcon col={h.key} />
                    </button>
                  </th>
                ))}
                <th className="text-right px-4 py-2.5 font-medium">
                  <button
                    type="button"
                    onClick={() => toggleSort('avgWeeklyQuantity')}
                    className={`flex items-center gap-1 ml-auto ${sortKey === 'avgWeeklyQuantity' ? 'text-blue-600' : ''}`}
                  >
                    週平均 <SortIcon col="avgWeeklyQuantity" />
                  </button>
                </th>
                <th className="text-center px-4 py-2.5 font-medium">
                  <button
                    type="button"
                    onClick={() => toggleSort('firstDate')}
                    className={`flex items-center gap-1 mx-auto ${sortKey === 'firstDate' ? 'text-blue-600' : ''}`}
                  >
                    期間 <SortIcon col="firstDate" />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {paged.map((p, i) => (
                <tr
                  key={p.code}
                  className="border-b border-gray-50 hover:bg-gray-50/50 transition-colors cursor-pointer"
                  onClick={() => onSelectProduct?.(p.code)}
                >
                  <td className="px-4 py-2.5 text-gray-400 font-mono text-xs">{page * perPage + i + 1}</td>
                  <td className="px-4 py-2.5 font-medium text-gray-900 max-w-[200px] truncate">
                    {p.name}
                  </td>
                  <td className="px-4 py-2.5">
                    {p.category && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                        {p.category}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">{formatYen(p.totalRevenue)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">{p.totalQuantity.toLocaleString()}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span
                      className={`font-mono text-xs px-1.5 py-0.5 rounded ${
                        p.marginRate >= 20
                          ? 'bg-green-50 text-green-700'
                          : p.marginRate >= 10
                            ? 'bg-yellow-50 text-yellow-700'
                            : 'bg-red-50 text-red-700'
                      }`}
                    >
                      {p.marginRate}%
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-gray-500">
                    {p.avgWeeklyQuantity}/週
                  </td>
                  <td className="px-4 py-2.5 text-center font-mono text-[10px] text-gray-400 whitespace-nowrap">
                    {p.firstDate && p.lastDate ? (
                      `${formatShortDate(p.firstDate)}~${formatShortDate(p.lastDate)}`
                    ) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100">
            <span className="text-xs text-gray-400">
              {page * perPage + 1}–{Math.min((page + 1) * perPage, sorted.length)} / {sorted.length}件
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
                className="px-2.5 py-1 text-xs rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                前へ
              </button>
              {Array.from({ length: totalPages }, (_, i) => i)
                .filter((i) => i === 0 || i === totalPages - 1 || Math.abs(i - page) <= 1)
                .reduce<(number | 'ellipsis')[]>((acc, i, idx, arr) => {
                  if (idx > 0 && i - (arr[idx - 1] as number) > 1) acc.push('ellipsis');
                  acc.push(i);
                  return acc;
                }, [])
                .map((item, idx) =>
                  item === 'ellipsis' ? (
                    <span key={`e${idx}`} className="px-1 text-xs text-gray-300">…</span>
                  ) : (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setPage(item)}
                      className={`min-w-[28px] py-1 text-xs rounded border ${
                        page === item
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      {item + 1}
                    </button>
                  ),
                )}
              <button
                type="button"
                disabled={page === totalPages - 1}
                onClick={() => setPage(page + 1)}
                className="px-2.5 py-1 text-xs rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                次へ
              </button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
