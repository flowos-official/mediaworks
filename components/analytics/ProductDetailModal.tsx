'use client';

import { useState, useEffect } from 'react';
import { X, Loader2, Package, Truck, ShieldCheck, BarChart3, HelpCircle, Tag, FileText, ImageIcon, Users, ChevronLeft, ChevronRight } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

type ContactInfo = { department?: string; person?: string; tel?: string; fax?: string; email?: string; company?: string; address?: string };

type DetailData = {
  product_name_kana: string | null;
  category_txd1: string | null;
  category_txd2: string | null;
  description: string | null;
  set_contents: string[] | null;
  skus: Array<{ name: string; color: string; size: string; price_incl: number | null; price_excl: number | null; shipping: number | null }> | null;
  return_policy: string | null;
  exchange_policy: string | null;
  care_instructions: string | null;
  usage_notes: string[] | null;
  faq: Array<{ question: string; answer: string }> | null;
  shipping_company: string | null;
  package_size: string | null;
  package_weight: number | null;
  jan_codes: string[] | null;
  wrapping: string | null;
  cost_price: number | null;
  wholesale_rate: number | null;
  manufacturer: string | null;
  manufacturer_country: string | null;
  supplier: string | null;
  txd_manager: string | null;
  supplier_contact: ContactInfo | null;
  sales_channels: { tv: boolean; ec: boolean; paper: boolean; other: boolean } | null;
  source_file: string | null;
  file_date: string | null;
  // New fields from 5-sheet expansion
  product_gr_number: string | null;
  materials: string | null;
  product_size: string | null;
  content_volume: string | null;
  manufacturing_country: string | null;
  sales_company: string | null;
  has_manual: string | null;
  has_warranty: string | null;
  expiry_info: string | null;
  product_form: string | null;
  web_description: string | null;
  emergency_treatment: string | null;
  intended_use: string | null;
  not_for_use: string | null;
  usage_amount: string | null;
  shelf_life: string | null;
  return_criteria: string | null;
  maker_part_number: string | null;
  shipping_notes: string | null;
  package_type: string | null;
  web_sales_info: { enabled?: boolean; web_product_name?: string; category?: string; coupon?: string; point_target?: string } | null;
  sales_period: { start?: string; end?: string } | null;
  order_unit: string | null;
  lead_time: string | null;
  order_contact: ContactInfo | null;
  inquiry_contact: ContactInfo | null;
  supplier_address: string | null;
  return_destination: ContactInfo | null;
  shipper_info: ContactInfo | null;
  payment_methods: { cash_on_delivery?: boolean; credit?: boolean; deferred?: boolean; no_charge?: boolean } | null;
  shipping_fees: { tv_shipping?: number; ec_shipping?: number; tv_deferred_fee?: number; ec_cod_fee?: number; ec_deferred_fee?: number } | null;
  subscription_info: { cycle?: string; price?: number; initial_price?: number } | null;
};

type ProductDetailData = {
  code: string;
  name: string;
  category: string | null;
  summary: {
    totalRevenue: number;
    totalProfit: number;
    totalQuantity: number;
    marginRate: number;
    weekCount: number;
    avgWeeklyQuantity: number;
  };
  weekly: Array<{ date: string; revenue: number; profit: number; quantity: number }>;
  detail: DetailData | null;
};

type ImageData = {
  id: string;
  sheet_name: string | null;
  s3_url: string;
  mime_type: string;
  sort_order: number;
};

type ModalTab = 'overview' | 'sku' | 'logistics' | 'confidential' | 'contacts' | 'images';

function formatYen(v: number): string {
  if (v >= 100_000_000) return `¥${(v / 100_000_000).toFixed(1)}億`;
  if (v >= 10_000) return `¥${Math.round(v / 10_000)}万`;
  return `¥${v.toLocaleString()}`;
}

function InfoRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === '' || value === '-') return null;
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="text-gray-500 text-xs min-w-[90px] shrink-0">{label}</span>
      <span className="text-gray-800 text-xs">{typeof value === 'number' ? value.toLocaleString() : value}</span>
    </div>
  );
}

export default function ProductDetailModal({
  productCode,
  onClose,
}: {
  productCode: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<ProductDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ModalTab>('overview');
  const [images, setImages] = useState<ImageData[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Lock body scroll while modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setActiveTab('overview');
    setImages([]);
    // Fetch product data and images in parallel
    Promise.all([
      fetch(`/api/analytics/products/${productCode}?year=2025,2026`)
        .then((res) => { if (!res.ok) throw new Error('Failed to fetch'); return res.json(); }),
      fetch(`/api/analytics/products/${productCode}/images`)
        .then((res) => res.json())
        .catch(() => ({ images: [] })),
    ])
      .then(([productData, imageData]) => {
        setData(productData);
        setImages(imageData.images ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [productCode]);

  const d = data?.detail;

  const tabs: { key: ModalTab; label: string; icon: typeof Package }[] = [
    { key: 'overview', label: '概要', icon: BarChart3 },
    { key: 'sku', label: 'SKU・FAQ', icon: Tag },
    { key: 'logistics', label: '物流・規定', icon: Truck },
    { key: 'confidential', label: '社外秘', icon: ShieldCheck },
    { key: 'contacts', label: '取引先', icon: Users },
    { key: 'images', label: '商品画像', icon: ImageIcon },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 pb-6">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[calc(100vh-3rem)] overflow-y-auto mx-4">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 rounded-t-2xl z-10">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-gray-900">{data?.name ?? productCode}</h2>
                {d?.product_name_kana && (
                  <span className="text-xs text-gray-400">({d.product_name_kana})</span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                {d?.category_txd1 && <Badge variant="secondary" className="text-[10px]">{d.category_txd1}</Badge>}
                {d?.category_txd2 && d.category_txd2 !== d.category_txd1 && (
                  <Badge variant="secondary" className="text-[10px]">{d.category_txd2}</Badge>
                )}
                {!d && data?.category && <Badge variant="secondary" className="text-[10px]">{data.category}</Badge>}
                <span className="text-xs text-gray-400 font-mono">{productCode}</span>
              </div>
            </div>
            <button type="button" onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg">
              <X size={18} className="text-gray-500" />
            </button>
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 mt-3">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                  activeTab === tab.key
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-500 hover:bg-gray-100'
                }`}
              >
                <tab.icon size={12} />
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="p-6 space-y-5">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={24} className="animate-spin text-blue-600" />
            </div>
          )}

          {error && <p className="text-red-500 text-sm">{error}</p>}

          {data && !loading && (
            <>
              {/* ========== TAB: 概要 ========== */}
              {activeTab === 'overview' && (
                <>
                  {/* Product Images */}
                  {images.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
                      {images.slice(0, 10).map((img, i) => (
                        <button
                          key={img.id}
                          type="button"
                          onClick={() => setLightboxIndex(i)}
                          className="shrink-0 w-24 h-24 rounded-lg overflow-hidden border border-gray-200 hover:border-blue-400 hover:shadow-md transition-all bg-gray-50 cursor-pointer"
                        >
                          <img src={img.s3_url} alt="" className="w-full h-full object-contain" loading="lazy" />
                        </button>
                      ))}
                      {images.length > 10 && (
                        <button
                          type="button"
                          onClick={() => setActiveTab('images')}
                          className="shrink-0 w-24 h-24 rounded-lg border border-gray-200 bg-gray-50 flex items-center justify-center text-xs text-gray-500 hover:bg-gray-100"
                        >
                          +{images.length - 10}枚
                        </button>
                      )}
                    </div>
                  )}

                  {/* KPI */}
                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    {[
                      { label: '総売上', value: formatYen(data.summary.totalRevenue) },
                      { label: '総粗利', value: formatYen(data.summary.totalProfit) },
                      { label: '粗利率', value: `${data.summary.marginRate}%` },
                      { label: '週平均', value: `${data.summary.avgWeeklyQuantity}個` },
                      { label: '販売週数', value: `${data.summary.weekCount}週` },
                    ].map((kpi) => (
                      <div key={kpi.label} className="bg-gray-50 rounded-xl p-3 text-center">
                        <div className="text-[10px] text-gray-500 uppercase">{kpi.label}</div>
                        <div className="text-lg font-bold text-gray-900">{kpi.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Chart */}
                  <Card className="border-gray-200">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                        <BarChart3 size={14} /> 週別売上推移
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="h-48">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={data.weekly} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
                            <defs>
                              <linearGradient id="modalRevGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15} />
                                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                            <XAxis
                              dataKey="date"
                              tickFormatter={(v) => { const p = v.slice(5).split('-'); return `${parseInt(p[0])}/${parseInt(p[1])}`; }}
                              tick={{ fontSize: 10, fill: '#9ca3af' }}
                            />
                            <YAxis
                              tickFormatter={(v) => v >= 10000 ? `${Math.round(v / 10000)}万` : v.toLocaleString()}
                              tick={{ fontSize: 10, fill: '#9ca3af' }}
                              width={50}
                            />
                            <Tooltip
                              formatter={(value: unknown) => [`¥${Number(value).toLocaleString()}`, '売上']}
                              contentStyle={{ fontSize: 11, borderRadius: 8 }}
                            />
                            <Area type="monotone" dataKey="revenue" stroke="#3b82f6" fill="url(#modalRevGrad)" strokeWidth={2} />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Description + Set Contents + Product Specs */}
                  {d && (
                    <Card className="border-gray-200">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                          <Package size={14} /> 商品情報
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {d.description && (
                          <p className="text-sm text-gray-700 leading-relaxed">{d.description}</p>
                        )}
                        {d.set_contents && d.set_contents.length > 0 && (
                          <div className="p-3 bg-gray-50 rounded-lg">
                            <span className="text-[10px] font-semibold text-gray-500 uppercase">セット内容</span>
                            <ul className="mt-1 space-y-0.5">
                              {d.set_contents.map((item, i) => (
                                <li key={i} className="text-xs text-gray-600">• {item}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {/* Product specs grid */}
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                          <InfoRow label="商品Gr番号" value={d.product_gr_number} />
                          <InfoRow label="製造国" value={d.manufacturing_country} />
                          <InfoRow label="商品サイズ" value={d.product_size} />
                          <InfoRow label="内容量" value={d.content_volume} />
                          <InfoRow label="材質・成分" value={d.materials} />
                          <InfoRow label="商品形態" value={d.product_form} />
                          <InfoRow label="販売元" value={d.sales_company} />
                          <InfoRow label="説明書" value={d.has_manual} />
                          <InfoRow label="保証書" value={d.has_warranty} />
                          <InfoRow label="消費期限" value={d.expiry_info} />
                        </div>
                        {d.web_description && (
                          <div className="p-3 bg-blue-50 rounded-lg">
                            <span className="text-[10px] font-semibold text-blue-600 uppercase">WEB説明</span>
                            <p className="text-xs text-gray-700 mt-1 leading-relaxed whitespace-pre-line">{d.web_description}</p>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {!d && (
                    <div className="py-4 px-5 text-sm bg-amber-50 border border-amber-200 rounded-xl">
                      <p className="font-medium text-amber-700">台帳ファイル未連携</p>
                      <p className="text-amber-600 text-xs mt-1">
                        E:\mediaworks フォルダ内に該当する台帳ファイルが見つかりませんでした。
                        台帳ファイルをアップロードするか、ファイル名の表記揺れを確認してください。
                      </p>
                    </div>
                  )}
                </>
              )}

              {/* ========== TAB: SKU・FAQ ========== */}
              {activeTab === 'sku' && d && (
                <>
                  {d.skus && d.skus.length > 0 ? (
                    <Card className="border-gray-200">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">SKU展開 ({d.skus.length}種)</CardTitle>
                      </CardHeader>
                      <CardContent className="p-0">
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-gray-100 text-gray-500">
                                <th className="text-left px-4 py-2">#</th>
                                <th className="text-left px-4 py-2">商品名</th>
                                <th className="text-left px-4 py-2">色</th>
                                <th className="text-left px-4 py-2">サイズ</th>
                                <th className="text-right px-4 py-2">税込価格</th>
                                <th className="text-right px-4 py-2">税抜価格</th>
                                <th className="text-right px-4 py-2">送料</th>
                              </tr>
                            </thead>
                            <tbody>
                              {d.skus.map((sku, i) => (
                                <tr key={i} className="border-b border-gray-50">
                                  <td className="px-4 py-1.5 text-gray-400 font-mono">{i + 1}</td>
                                  <td className="px-4 py-1.5 text-gray-700 font-medium">{sku.name}</td>
                                  <td className="px-4 py-1.5 text-gray-600">{sku.color || '-'}</td>
                                  <td className="px-4 py-1.5 text-gray-600">{sku.size || '-'}</td>
                                  <td className="px-4 py-1.5 text-right font-mono">{sku.price_incl ? `¥${sku.price_incl.toLocaleString()}` : '-'}</td>
                                  <td className="px-4 py-1.5 text-right font-mono text-gray-500">{sku.price_excl ? `¥${sku.price_excl.toLocaleString()}` : '-'}</td>
                                  <td className="px-4 py-1.5 text-right font-mono text-gray-500">{sku.shipping ? `¥${sku.shipping.toLocaleString()}` : '-'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="text-center py-6 text-sm text-gray-400">SKUデータなし</div>
                  )}

                  {/* FAQ */}
                  {d.faq && d.faq.length > 0 && (
                    <Card className="border-gray-200">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                          <HelpCircle size={14} /> よくあるお問い合わせ ({d.faq.length}件)
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {d.faq.map((item, i) => (
                          <div key={i} className="border-l-2 border-blue-200 pl-3">
                            <div className="text-xs font-semibold text-gray-800">Q: {item.question}</div>
                            <div className="text-xs text-gray-600 mt-0.5">A: {item.answer}</div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}

                  {/* Usage details */}
                  {(d.intended_use || d.not_for_use || d.usage_amount || d.shelf_life || d.emergency_treatment) && (
                    <Card className="border-gray-200">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                          <FileText size={14} /> 使用情報
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {d.intended_use && (
                          <div>
                            <span className="text-[10px] font-semibold text-gray-500 uppercase">用途</span>
                            <p className="text-xs text-gray-700 mt-0.5 whitespace-pre-line">{d.intended_use}</p>
                          </div>
                        )}
                        {d.not_for_use && (
                          <div>
                            <span className="text-[10px] font-semibold text-red-500 uppercase">使用不可対象</span>
                            <p className="text-xs text-gray-700 mt-0.5 whitespace-pre-line">{d.not_for_use}</p>
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                          <InfoRow label="使用量目安" value={d.usage_amount} />
                          <InfoRow label="使用期限" value={d.shelf_life} />
                        </div>
                        {d.emergency_treatment && (
                          <div className="p-2.5 bg-red-50 border border-red-100 rounded-lg">
                            <span className="text-[10px] font-semibold text-red-600 uppercase">応急処置</span>
                            <p className="text-xs text-gray-700 mt-0.5 whitespace-pre-line">{d.emergency_treatment}</p>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {!d.skus && !d.faq && !d.intended_use && (
                    <div className="text-center py-6 text-sm text-gray-400">SKU・FAQデータなし</div>
                  )}
                </>
              )}

              {/* ========== TAB: 物流・規定 ========== */}
              {activeTab === 'logistics' && d && (
                <div className="space-y-5">
                  <Card className="border-gray-200">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                        <Truck size={14} /> 配送・梱包情報
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <InfoRow label="配送会社" value={d.shipping_company} />
                      <InfoRow label="梱包サイズ" value={d.package_size ? `${d.package_size} cm` : null} />
                      <InfoRow label="重量" value={d.package_weight != null ? `${d.package_weight} kg` : null} />
                      <InfoRow label="梱包形態" value={d.package_type} />
                      <InfoRow label="ラッピング" value={d.wrapping} />
                      <InfoRow label="メーカー品番" value={d.maker_part_number} />
                      {d.shipping_notes && <InfoRow label="配送備考" value={d.shipping_notes} />}
                      {d.jan_codes && d.jan_codes.length > 0 && (
                        <div className="flex items-start gap-2 py-1">
                          <span className="text-gray-500 text-xs min-w-[90px] shrink-0">JANコード</span>
                          <div className="flex flex-wrap gap-1">
                            {d.jan_codes.map((code) => (
                              <span key={code} className="font-mono text-[10px] bg-gray-100 px-1.5 py-0.5 rounded text-gray-700">{code}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="border-gray-200">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                        <FileText size={14} /> 返品・交換・ケア
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <InfoRow label="返品" value={d.return_policy} />
                      <InfoRow label="交換" value={d.exchange_policy} />
                      <InfoRow label="お手入れ" value={d.care_instructions} />
                      <InfoRow label="返品基準" value={d.return_criteria} />
                    </CardContent>
                  </Card>

                  {/* WEB販売・決済情報 */}
                  {(d.web_sales_info || d.payment_methods || d.shipping_fees) && (
                    <Card className="border-gray-200">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">WEB販売・決済情報</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {d.web_sales_info && (
                          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                            <InfoRow label="WEB販売" value={d.web_sales_info.enabled ? '〇' : '-'} />
                            <InfoRow label="WEB商品名" value={d.web_sales_info.web_product_name} />
                            <InfoRow label="ECカテゴリ" value={d.web_sales_info.category} />
                            <InfoRow label="クーポン" value={d.web_sales_info.coupon} />
                            <InfoRow label="ポイント対象" value={d.web_sales_info.point_target} />
                          </div>
                        )}
                        {d.payment_methods && (
                          <div className="flex items-center gap-2 py-1">
                            <span className="text-gray-500 text-xs min-w-[90px] shrink-0">支払方法</span>
                            <div className="flex gap-1">
                              {d.payment_methods.cash_on_delivery && <Badge variant="secondary" className="text-[9px]">代引き</Badge>}
                              {d.payment_methods.credit && <Badge variant="secondary" className="text-[9px]">クレジット</Badge>}
                              {d.payment_methods.deferred && <Badge variant="secondary" className="text-[9px]">後払い</Badge>}
                            </div>
                          </div>
                        )}
                        {d.shipping_fees && (
                          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                            <InfoRow label="TV送料" value={d.shipping_fees.tv_shipping ? `¥${d.shipping_fees.tv_shipping}` : null} />
                            <InfoRow label="EC送料" value={d.shipping_fees.ec_shipping ? `¥${d.shipping_fees.ec_shipping}` : null} />
                            <InfoRow label="EC代引手数料" value={d.shipping_fees.ec_cod_fee ? `¥${d.shipping_fees.ec_cod_fee}` : null} />
                            <InfoRow label="EC後払手数料" value={d.shipping_fees.ec_deferred_fee ? `¥${d.shipping_fees.ec_deferred_fee}` : null} />
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {d.usage_notes && d.usage_notes.length > 0 && (
                    <Card className="border-yellow-200 bg-yellow-50/30">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold text-yellow-700">使用上の注意</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-1">
                          {d.usage_notes.map((note, i) => (
                            <li key={i} className="text-xs text-gray-700 flex gap-1.5">
                              <span className="text-yellow-500 shrink-0">⚠</span> {note}
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}

              {/* ========== TAB: 社外秘 ========== */}
              {activeTab === 'confidential' && d && (
                <div className="space-y-5">
                  {/* Pricing */}
                  <Card className="border-orange-200 bg-orange-50/30">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold text-orange-700 flex items-center gap-1.5">
                        <ShieldCheck size={14} /> 仕入・原価情報
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 gap-4 mb-3">
                        <div className="bg-white rounded-lg p-3 text-center border border-orange-100">
                          <div className="text-[10px] text-gray-500">仕入価格(税抜)</div>
                          <div className="text-xl font-bold text-gray-900">
                            {d.cost_price != null ? `¥${d.cost_price.toLocaleString()}` : '-'}
                          </div>
                        </div>
                        <div className="bg-white rounded-lg p-3 text-center border border-orange-100">
                          <div className="text-[10px] text-gray-500">仕入率</div>
                          <div className="text-xl font-bold text-gray-900">
                            {d.wholesale_rate != null ? `${d.wholesale_rate.toFixed(1)}%` : '-'}
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                        {d.sales_period && (
                          <>
                            <InfoRow label="販売開始" value={d.sales_period.start} />
                            <InfoRow label="販売終了" value={d.sales_period.end} />
                          </>
                        )}
                        <InfoRow label="発注単位" value={d.order_unit} />
                        <InfoRow label="リードタイム" value={d.lead_time} />
                      </div>
                    </CardContent>
                  </Card>

                  {/* Manufacturer */}
                  <Card className="border-gray-200">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold">製造・供給元</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <InfoRow label="メーカー" value={d.manufacturer} />
                      <InfoRow label="製造国" value={d.manufacturer_country} />
                      <InfoRow label="サプライヤー" value={d.supplier} />
                      <InfoRow label="TXD担当" value={d.txd_manager} />
                      {d.sales_channels && (
                        <div className="flex items-center gap-2 py-1">
                          <span className="text-gray-500 text-xs min-w-[90px] shrink-0">販売媒体</span>
                          <div className="flex gap-1">
                            {d.sales_channels.tv && <Badge variant="secondary" className="text-[9px]">TV</Badge>}
                            {d.sales_channels.ec && <Badge variant="secondary" className="text-[9px]">EC</Badge>}
                            {d.sales_channels.paper && <Badge variant="secondary" className="text-[9px]">紙</Badge>}
                            {d.sales_channels.other && <Badge variant="secondary" className="text-[9px]">その他</Badge>}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Supplier Contact */}
                  {d.supplier_contact && (
                    <Card className="border-gray-200">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">取引先連絡先</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <InfoRow label="会社名" value={d.supplier_contact.company} />
                        <InfoRow label="担当者" value={d.supplier_contact.person} />
                        <InfoRow label="TEL" value={d.supplier_contact.tel} />
                        <InfoRow label="FAX" value={d.supplier_contact.fax} />
                        <InfoRow label="メール" value={d.supplier_contact.email} />
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}

              {/* ========== TAB: 取引先 ========== */}
              {activeTab === 'contacts' && d && (
                <div className="space-y-5">
                  {/* 営業部門 (supplier_contact) */}
                  {d.supplier_contact && (
                    <Card className="border-gray-200">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">営業部門</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <InfoRow label="会社名" value={d.supplier_contact.company} />
                        <InfoRow label="担当者" value={d.supplier_contact.person} />
                        <InfoRow label="TEL" value={d.supplier_contact.tel} />
                        <InfoRow label="FAX" value={d.supplier_contact.fax} />
                        <InfoRow label="メール" value={d.supplier_contact.email} />
                        <InfoRow label="住所" value={d.supplier_address} />
                      </CardContent>
                    </Card>
                  )}

                  {/* 発注書送付先 */}
                  {d.order_contact && (
                    <Card className="border-gray-200">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">発注書送付先</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <InfoRow label="部門" value={d.order_contact.department} />
                        <InfoRow label="担当者" value={d.order_contact.person} />
                        <InfoRow label="TEL" value={d.order_contact.tel} />
                        <InfoRow label="FAX" value={d.order_contact.fax} />
                        <InfoRow label="メール" value={d.order_contact.email} />
                      </CardContent>
                    </Card>
                  )}

                  {/* 問合せ先 */}
                  {d.inquiry_contact && (
                    <Card className="border-gray-200">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">問合せ先</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <InfoRow label="部門" value={d.inquiry_contact.department} />
                        <InfoRow label="担当者" value={d.inquiry_contact.person} />
                        <InfoRow label="TEL" value={d.inquiry_contact.tel} />
                        <InfoRow label="FAX" value={d.inquiry_contact.fax} />
                        <InfoRow label="メール" value={d.inquiry_contact.email} />
                      </CardContent>
                    </Card>
                  )}

                  {/* 返品商品送付先 */}
                  {d.return_destination && (
                    <Card className="border-orange-200 bg-orange-50/30">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold text-orange-700">返品商品送付先</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <InfoRow label="会社名" value={d.return_destination.company} />
                        <InfoRow label="担当者" value={d.return_destination.person} />
                        <InfoRow label="TEL" value={d.return_destination.tel} />
                        <InfoRow label="住所" value={d.return_destination.address} />
                      </CardContent>
                    </Card>
                  )}

                  {/* 出荷元 */}
                  {d.shipper_info && (
                    <Card className="border-gray-200">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">出荷元</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <InfoRow label="会社名" value={d.shipper_info.company} />
                        <InfoRow label="担当者" value={d.shipper_info.person} />
                        <InfoRow label="TEL" value={d.shipper_info.tel} />
                        <InfoRow label="メール" value={d.shipper_info.email} />
                      </CardContent>
                    </Card>
                  )}

                  {!d.supplier_contact && !d.order_contact && !d.return_destination && !d.shipper_info && (
                    <div className="text-center py-6 text-sm text-gray-400">取引先データなし</div>
                  )}
                </div>
              )}

              {/* ========== TAB: 商品画像 ========== */}
              {activeTab === 'images' && (
                <>
                  {images.length === 0 && (
                    <div className="py-4 px-5 text-sm bg-amber-50 border border-amber-200 rounded-xl">
                      <p className="font-medium text-amber-700">商品画像なし</p>
                      <p className="text-amber-600 text-xs mt-1">
                        {!d
                          ? '台帳ファイルが未連携のため画像がありません。'
                          : '台帳ファイルに画像が含まれていないか、画像抽出に失敗しました。'}
                      </p>
                    </div>
                  )}
                  {images.length > 0 && (() => {
                    const grouped = new Map<string, { img: ImageData; flatIndex: number }[]>();
                    for (let fi = 0; fi < images.length; fi++) {
                      const img = images[fi];
                      const key = img.sheet_name ?? '未分類';
                      if (!grouped.has(key)) grouped.set(key, []);
                      grouped.get(key)!.push({ img, flatIndex: fi });
                    }
                    return Array.from(grouped.entries()).map(([sheetName, items]) => (
                      <Card key={sheetName} className="border-gray-200">
                        <CardHeader className="pb-1">
                          <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                            <ImageIcon size={14} /> {sheetName}
                            <span className="text-xs font-normal text-gray-400">({items.length}枚)</span>
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            {items.map(({ img, flatIndex }) => (
                              <button
                                key={img.id}
                                type="button"
                                onClick={() => setLightboxIndex(flatIndex)}
                                className="aspect-square rounded-lg overflow-hidden border border-gray-200 hover:border-blue-400 hover:shadow-md transition-all bg-gray-50 cursor-pointer"
                              >
                                <img
                                  src={img.s3_url}
                                  alt=""
                                  className="w-full h-full object-contain"
                                  loading="lazy"
                                />
                              </button>
                            ))}
                          </div>
                        </CardContent>
                      </Card>
                    ));
                  })()}
                </>
              )}

              {/* Lightbox with prev/next */}
              {lightboxIndex !== null && images[lightboxIndex] && (
                <div
                  className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70"
                  onClick={() => setLightboxIndex(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft' && lightboxIndex > 0) setLightboxIndex(lightboxIndex - 1);
                    if (e.key === 'ArrowRight' && lightboxIndex < images.length - 1) setLightboxIndex(lightboxIndex + 1);
                    if (e.key === 'Escape') setLightboxIndex(null);
                  }}
                  tabIndex={0}
                >
                  {/* Close */}
                  <button
                    type="button"
                    onClick={() => setLightboxIndex(null)}
                    className="absolute top-4 right-4 bg-white/90 rounded-full p-1.5 shadow-lg hover:bg-white z-10"
                  >
                    <X size={18} />
                  </button>

                  {/* Counter */}
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/50 text-white text-xs px-3 py-1 rounded-full">
                    {lightboxIndex + 1} / {images.length}
                  </div>

                  {/* Previous */}
                  {lightboxIndex > 0 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setLightboxIndex(lightboxIndex - 1); }}
                      className="absolute left-3 top-1/2 -translate-y-1/2 bg-white/90 rounded-full p-2 shadow-lg hover:bg-white z-10"
                    >
                      <ChevronLeft size={20} />
                    </button>
                  )}

                  {/* Image */}
                  <img
                    src={images[lightboxIndex].s3_url}
                    alt=""
                    className="max-w-[85vw] max-h-[85vh] object-contain rounded-lg shadow-2xl"
                    onClick={(e) => e.stopPropagation()}
                  />

                  {/* Next */}
                  {lightboxIndex < images.length - 1 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setLightboxIndex(lightboxIndex + 1); }}
                      className="absolute right-3 top-1/2 -translate-y-1/2 bg-white/90 rounded-full p-2 shadow-lg hover:bg-white z-10"
                    >
                      <ChevronRight size={20} />
                    </button>
                  )}
                </div>
              )}

              {/* No detail fallback for non-overview tabs */}
              {activeTab !== 'overview' && activeTab !== 'images' && !d && (
                <div className="py-4 px-5 text-sm bg-amber-50 border border-amber-200 rounded-xl">
                  <p className="font-medium text-amber-700">台帳ファイル未連携</p>
                  <p className="text-amber-600 text-xs mt-1">
                    該当する台帳ファイルが見つからないため、このタブのデータを表示できません。
                  </p>
                </div>
              )}

              {/* Data source footer */}
              {d?.source_file && (
                <div className="text-[10px] text-gray-400 text-right pt-2 border-t border-gray-100">
                  出典: {d.source_file} {d.file_date ? `(${d.file_date})` : ''}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
