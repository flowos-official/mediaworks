'use client';

import { useState, useEffect, useRef } from 'react';
import { X, Loader2, Package, Truck, ShieldCheck, BarChart3, HelpCircle, Tag, FileText, ImageIcon, Users, ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
    totalProfit: number | null;
    totalQuantity: number;
    marginRate: number | null;
    weekCount: number;
    avgWeeklyQuantity: number;
  };
  weekly: Array<{ date: string; revenue: number; profit: number | null; quantity: number }>;
  detail: DetailData | null;
  viewer?: boolean;
};

type ImageData = {
  id: string;
  sheet_name: string | null;
  s3_url: string;
  mime_type: string;
  sort_order: number;
};

type ModalTab = 'overview' | 'sku' | 'logistics' | 'confidential' | 'contacts' | 'images';

type ProductDetailLoadState = {
  requestKey: string | null;
  productCode: string | null;
  data: ProductDetailData | null;
  images: ImageData[];
  error: string | null;
};

function formatYen(v: number): string {
  if (v >= 100_000_000) return `¥${(v / 100_000_000).toFixed(1)}億`;
  if (v >= 10_000) return `¥${Math.round(v / 10_000)}万`;
  return `¥${v.toLocaleString()}`;
}

function InfoRow({ label, value }: { label: string; value: string | number | null | undefined }) {
  if (value == null || value === '' || value === '-') return null;
  return (
    <div className="flex items-start gap-2 py-1">
      <span className="text-muted-foreground text-xs min-w-[90px] shrink-0">{label}</span>
      <span className="text-foreground text-xs">{typeof value === 'number' ? value.toLocaleString() : value}</span>
    </div>
  );
}

export default function ProductDetailModal({
  productCode,
  years,
  onClose,
}: {
  productCode: string;
  years?: number[];
  onClose: () => void;
}) {
  const t = useTranslations('productDetailModal');
  const yearParam = (years?.length ? years : [2025, 2026]).join(',');
  const requestKey = `${productCode}:${yearParam}`;
  const [loadState, setLoadState] = useState<ProductDetailLoadState>({
    requestKey: null,
    productCode: null,
    data: null,
    images: [],
    error: null,
  });
  const [activeTabState, setActiveTabState] = useState<{
    productCode: string;
    tab: ModalTab;
  } | null>(null);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const lightboxRef = useRef<HTMLDivElement | null>(null);

  // Lock body scroll while modal is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Focus the lightbox dialog when it opens (a11y).
  useEffect(() => {
    if (lightboxIndex !== null) {
      lightboxRef.current?.focus();
    }
  }, [lightboxIndex]);

  useEffect(() => {
    let ignore = false;
    // Fetch product data and images in parallel
    Promise.all([
      fetch(`/api/analytics/products/${productCode}?year=${encodeURIComponent(yearParam)}`)
        .then((res) => { if (!res.ok) throw new Error('Failed to fetch'); return res.json(); }),
      fetch(`/api/analytics/products/${productCode}/images`)
        .then((res) => res.json())
        .catch(() => ({ images: [] })),
    ])
      .then(([productData, imageData]) => {
        if (ignore) return;
        setLoadState({
          requestKey,
          productCode,
          data: productData,
          images: imageData.images ?? [],
          error: null,
        });
      })
      .catch((err) => {
        if (ignore) return;
        setLoadState({
          requestKey,
          productCode,
          data: null,
          images: [],
          error: err.message,
        });
      });
    return () => {
      ignore = true;
    };
  }, [productCode, requestKey, yearParam]);

  const isCurrentLoad = loadState.requestKey === requestKey;
  const data = isCurrentLoad ? loadState.data : null;
  const images = isCurrentLoad ? loadState.images : [];
  const error = isCurrentLoad ? loadState.error : null;
  const loading = !isCurrentLoad;
  const activeTab =
    activeTabState?.productCode === productCode ? activeTabState.tab : 'overview';
  const setActiveTab = (tab: ModalTab) => {
    setActiveTabState({ productCode, tab });
  };

  const d = data?.detail;
  const isViewer = data?.viewer === true;

  const tabs: { key: ModalTab; label: string; icon: typeof Package }[] = [
    { key: 'overview', label: t('tabs.overview'), icon: BarChart3 },
    { key: 'sku', label: t('tabs.sku'), icon: Tag },
    { key: 'logistics', label: t('tabs.logistics'), icon: Truck },
    // 社外秘 tab is hidden for viewer role
    ...(isViewer ? [] : [{ key: 'confidential' as ModalTab, label: t('tabs.confidential'), icon: ShieldCheck }]),
    { key: 'contacts', label: t('tabs.contacts'), icon: Users },
    { key: 'images', label: t('tabs.images'), icon: ImageIcon },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-6 pb-6">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative bg-card rounded-2xl shadow-2xl w-full max-w-4xl max-h-[calc(100vh-3rem)] overflow-y-auto mx-4">
        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border px-6 py-4 rounded-t-2xl z-10">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-foreground">{data?.name ?? productCode}</h2>
                {d?.product_name_kana && (
                  <span className="text-xs text-muted-foreground">({d.product_name_kana})</span>
                )}
              </div>
              <div className="flex items-center gap-2 mt-0.5">
                {d?.category_txd1 && <Badge variant="secondary" className="text-[10px]">{d.category_txd1}</Badge>}
                {d?.category_txd2 && d.category_txd2 !== d.category_txd1 && (
                  <Badge variant="secondary" className="text-[10px]">{d.category_txd2}</Badge>
                )}
                {!d && data?.category && <Badge variant="secondary" className="text-[10px]">{data.category}</Badge>}
                <span className="text-xs text-muted-foreground font-mono">{productCode}</span>
              </div>
            </div>
            <button type="button" onClick={onClose} className="p-1.5 hover:bg-muted rounded-lg">
              <X size={18} className="text-muted-foreground" />
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
                    : 'text-muted-foreground hover:bg-muted'
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

          {error && <p className="text-red-500 dark:text-red-400 text-sm">{error}</p>}

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
                          className="shrink-0 w-24 h-24 rounded-lg overflow-hidden border border-border hover:border-blue-400 hover:shadow-md transition-all bg-muted cursor-pointer"
                        >
                          <img src={img.s3_url} alt="" className="w-full h-full object-contain" loading="lazy" />
                        </button>
                      ))}
                      {images.length > 10 && (
                        <button
                          type="button"
                          onClick={() => setActiveTab('images')}
                          className="shrink-0 w-24 h-24 rounded-lg border border-border bg-muted flex items-center justify-center text-xs text-muted-foreground hover:bg-accent"
                        >
                          {t('moreImages', { count: images.length - 10 })}
                        </button>
                      )}
                    </div>
                  )}

                  {/* KPI — 総粗利 hidden for viewer */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {([
                      { label: t('kpi.totalRevenue'), value: formatYen(data.summary.totalRevenue) },
                      data.summary.totalProfit != null
                        ? { label: t('kpi.totalProfit'), value: formatYen(data.summary.totalProfit) }
                        : null,
                      { label: t('kpi.weeklyAvg'), value: t('kpi.weeklyAvgValue', { count: data.summary.avgWeeklyQuantity }) },
                      { label: t('kpi.weekCount'), value: t('kpi.weekCountValue', { count: data.summary.weekCount }) },
                    ].filter((x): x is { label: string; value: string } => x !== null)).map((kpi) => (
                      <div key={kpi.label} className="bg-muted rounded-xl p-3 text-center">
                        <div className="text-[10px] text-muted-foreground uppercase">{kpi.label}</div>
                        <div className="text-lg font-bold text-foreground">{kpi.value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Chart */}
                  <Card className="border-border">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                        <BarChart3 size={14} /> {t('sections.weeklyRevenue')}
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
                              formatter={(value: unknown) => [`¥${Number(value).toLocaleString()}`, t('chartTooltipRevenue')]}
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
                    <Card className="border-border">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                          <Package size={14} /> {t('sections.productInfo')}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {d.description && (
                          <p className="text-sm text-foreground leading-relaxed">{d.description}</p>
                        )}
                        {d.set_contents && d.set_contents.length > 0 && (
                          <div className="p-3 bg-muted rounded-lg">
                            <span className="text-[10px] font-semibold text-muted-foreground uppercase">{t('setContents')}</span>
                            <ul className="mt-1 space-y-0.5">
                              {d.set_contents.map((item, i) => (
                                <li key={i} className="text-xs text-muted-foreground">• {item}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {/* Product specs grid */}
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                          <InfoRow label={t('specs.productGrNumber')} value={d.product_gr_number} />
                          <InfoRow label={t('specs.manufacturingCountry')} value={d.manufacturing_country} />
                          <InfoRow label={t('specs.productSize')} value={d.product_size} />
                          <InfoRow label={t('specs.contentVolume')} value={d.content_volume} />
                          <InfoRow label={t('specs.materials')} value={d.materials} />
                          <InfoRow label={t('specs.productForm')} value={d.product_form} />
                          <InfoRow label={t('specs.salesCompany')} value={d.sales_company} />
                          <InfoRow label={t('specs.hasManual')} value={d.has_manual} />
                          <InfoRow label={t('specs.hasWarranty')} value={d.has_warranty} />
                          <InfoRow label={t('specs.expiryInfo')} value={d.expiry_info} />
                        </div>
                        {d.web_description && (
                          <div className="p-3 bg-blue-600/10 rounded-lg">
                            <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-300 uppercase">{t('webDescription')}</span>
                            <p className="text-xs text-foreground mt-1 leading-relaxed whitespace-pre-line">{d.web_description}</p>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {!d && (
                    <div className="py-4 px-5 text-sm bg-amber-600/10 border border-amber-600/30 rounded-xl">
                      <p className="font-medium text-amber-700 dark:text-amber-300">{t('ledgerMissing.title')}</p>
                      <p className="text-amber-700/80 dark:text-amber-300/80 text-xs mt-1">{t('ledgerMissing.description')}</p>
                    </div>
                  )}
                </>
              )}

              {/* ========== TAB: SKU・FAQ ========== */}
              {activeTab === 'sku' && d && (
                <>
                  {d.skus && d.skus.length > 0 ? (
                    <Card className="border-border">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">{t('sku.title')} ({t('sku.count', { count: d.skus.length })})</CardTitle>
                      </CardHeader>
                      <CardContent className="p-0">
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="border-b border-border text-muted-foreground">
                                <th className="text-left px-4 py-2">{t('sku.cols.index')}</th>
                                <th className="text-left px-4 py-2">{t('sku.cols.name')}</th>
                                <th className="text-left px-4 py-2">{t('sku.cols.color')}</th>
                                <th className="text-left px-4 py-2">{t('sku.cols.size')}</th>
                                <th className="text-right px-4 py-2">{t('sku.cols.priceIncl')}</th>
                                <th className="text-right px-4 py-2">{t('sku.cols.priceExcl')}</th>
                                <th className="text-right px-4 py-2">{t('sku.cols.shipping')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {d.skus.map((sku, i) => (
                                <tr key={i} className="border-b border-border">
                                  <td className="px-4 py-1.5 text-muted-foreground font-mono">{i + 1}</td>
                                  <td className="px-4 py-1.5 text-foreground font-medium">{sku.name}</td>
                                  <td className="px-4 py-1.5 text-muted-foreground">{sku.color || '-'}</td>
                                  <td className="px-4 py-1.5 text-muted-foreground">{sku.size || '-'}</td>
                                  <td className="px-4 py-1.5 text-right font-mono">{sku.price_incl ? `¥${sku.price_incl.toLocaleString()}` : '-'}</td>
                                  <td className="px-4 py-1.5 text-right font-mono text-muted-foreground">{sku.price_excl ? `¥${sku.price_excl.toLocaleString()}` : '-'}</td>
                                  <td className="px-4 py-1.5 text-right font-mono text-muted-foreground">{sku.shipping ? `¥${sku.shipping.toLocaleString()}` : '-'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="text-center py-6 text-sm text-muted-foreground">{t('sku.empty')}</div>
                  )}

                  {/* FAQ */}
                  {d.faq && d.faq.length > 0 && (
                    <Card className="border-border">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                          <HelpCircle size={14} /> {t('faq.title')} ({t('faq.count', { count: d.faq.length })})
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {d.faq.map((item, i) => (
                          <div key={i} className="border-l-2 border-blue-600/30 pl-3">
                            <div className="text-xs font-semibold text-foreground">{t('faq.questionPrefix')} {item.question}</div>
                            <div className="text-xs text-muted-foreground mt-0.5">{t('faq.answerPrefix')} {item.answer}</div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}

                  {/* Usage details */}
                  {(d.intended_use || d.not_for_use || d.usage_amount || d.shelf_life || d.emergency_treatment) && (
                    <Card className="border-border">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                          <FileText size={14} /> {t('usage.title')}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {d.intended_use && (
                          <div>
                            <span className="text-[10px] font-semibold text-muted-foreground uppercase">{t('usage.intendedUse')}</span>
                            <p className="text-xs text-foreground mt-0.5 whitespace-pre-line">{d.intended_use}</p>
                          </div>
                        )}
                        {d.not_for_use && (
                          <div>
                            <span className="text-[10px] font-semibold text-red-500 dark:text-red-400 uppercase">{t('usage.notForUse')}</span>
                            <p className="text-xs text-foreground mt-0.5 whitespace-pre-line">{d.not_for_use}</p>
                          </div>
                        )}
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                          <InfoRow label={t('usage.usageAmount')} value={d.usage_amount} />
                          <InfoRow label={t('usage.shelfLife')} value={d.shelf_life} />
                        </div>
                        {d.emergency_treatment && (
                          <div className="p-2.5 bg-red-600/10 border border-red-600/20 rounded-lg">
                            <span className="text-[10px] font-semibold text-red-600 dark:text-red-400 uppercase">{t('usage.emergency')}</span>
                            <p className="text-xs text-foreground mt-0.5 whitespace-pre-line">{d.emergency_treatment}</p>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {!d.skus && !d.faq && !d.intended_use && (
                    <div className="text-center py-6 text-sm text-muted-foreground">{t('skuFaqEmpty')}</div>
                  )}
                </>
              )}

              {/* ========== TAB: 物流・規定 ========== */}
              {activeTab === 'logistics' && d && (
                <div className="space-y-5">
                  <Card className="border-border">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                        <Truck size={14} /> {t('logistics.title')}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <InfoRow label={t('logistics.shippingCompany')} value={d.shipping_company} />
                      <InfoRow label={t('logistics.packageSize')} value={d.package_size ? `${d.package_size} cm` : null} />
                      <InfoRow label={t('logistics.weight')} value={d.package_weight != null ? `${d.package_weight} kg` : null} />
                      <InfoRow label={t('logistics.packageType')} value={d.package_type} />
                      <InfoRow label={t('logistics.wrapping')} value={d.wrapping} />
                      <InfoRow label={t('logistics.makerPartNumber')} value={d.maker_part_number} />
                      {d.shipping_notes && <InfoRow label={t('logistics.shippingNotes')} value={d.shipping_notes} />}
                      {d.jan_codes && d.jan_codes.length > 0 && (
                        <div className="flex items-start gap-2 py-1">
                          <span className="text-muted-foreground text-xs min-w-[90px] shrink-0">{t('logistics.janCodes')}</span>
                          <div className="flex flex-wrap gap-1">
                            {d.jan_codes.map((code) => (
                              <span key={code} className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded text-foreground">{code}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  <Card className="border-border">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                        <FileText size={14} /> {t('policy.title')}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <InfoRow label={t('policy.returnPolicy')} value={d.return_policy} />
                      <InfoRow label={t('policy.exchangePolicy')} value={d.exchange_policy} />
                      <InfoRow label={t('policy.careInstructions')} value={d.care_instructions} />
                      <InfoRow label={t('policy.returnCriteria')} value={d.return_criteria} />
                    </CardContent>
                  </Card>

                  {/* WEB販売・決済情報 */}
                  {(d.web_sales_info || d.payment_methods || d.shipping_fees) && (
                    <Card className="border-border">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">{t('web.title')}</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {d.web_sales_info && (
                          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                            <InfoRow label={t('web.enabled')} value={d.web_sales_info.enabled ? '〇' : '-'} />
                            <InfoRow label={t('web.productName')} value={d.web_sales_info.web_product_name} />
                            <InfoRow label={t('web.category')} value={d.web_sales_info.category} />
                            <InfoRow label={t('web.coupon')} value={d.web_sales_info.coupon} />
                            <InfoRow label={t('web.pointTarget')} value={d.web_sales_info.point_target} />
                          </div>
                        )}
                        {d.payment_methods && (
                          <div className="flex items-center gap-2 py-1">
                            <span className="text-muted-foreground text-xs min-w-[90px] shrink-0">{t('web.paymentMethod')}</span>
                            <div className="flex gap-1">
                              {d.payment_methods.cash_on_delivery && <Badge variant="secondary" className="text-[9px]">{t('web.cod')}</Badge>}
                              {d.payment_methods.credit && <Badge variant="secondary" className="text-[9px]">{t('web.credit')}</Badge>}
                              {d.payment_methods.deferred && <Badge variant="secondary" className="text-[9px]">{t('web.deferred')}</Badge>}
                            </div>
                          </div>
                        )}
                        {d.shipping_fees && (
                          <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                            <InfoRow label={t('web.tvShipping')} value={d.shipping_fees.tv_shipping ? `¥${d.shipping_fees.tv_shipping}` : null} />
                            <InfoRow label={t('web.ecShipping')} value={d.shipping_fees.ec_shipping ? `¥${d.shipping_fees.ec_shipping}` : null} />
                            <InfoRow label={t('web.ecCodFee')} value={d.shipping_fees.ec_cod_fee ? `¥${d.shipping_fees.ec_cod_fee}` : null} />
                            <InfoRow label={t('web.ecDeferredFee')} value={d.shipping_fees.ec_deferred_fee ? `¥${d.shipping_fees.ec_deferred_fee}` : null} />
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  )}

                  {d.usage_notes && d.usage_notes.length > 0 && (
                    <Card className="border-yellow-500/30 bg-yellow-500/10">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold text-yellow-700 dark:text-yellow-300">{t('usageNotesTitle')}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-1">
                          {d.usage_notes.map((note, i) => (
                            <li key={i} className="text-xs text-foreground flex gap-1.5">
                              <span className="text-yellow-500 shrink-0">⚠</span> {note}
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  )}
                </div>
              )}

              {/* ========== TAB: 社外秘 — hidden for viewer ========== */}
              {activeTab === 'confidential' && d && !isViewer && (
                <div className="space-y-5">
                  {/* Pricing */}
                  <Card className="border-orange-600/30 bg-orange-600/10">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold text-orange-700 dark:text-orange-300 flex items-center gap-1.5">
                        <ShieldCheck size={14} /> {t('confidential.priceTitle')}
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 gap-4 mb-3">
                        <div className="bg-card rounded-lg p-3 text-center border border-orange-600/20">
                          <div className="text-[10px] text-muted-foreground">{t('confidential.costPrice')}</div>
                          <div className="text-xl font-bold text-foreground">
                            {d.cost_price != null ? `¥${d.cost_price.toLocaleString()}` : '-'}
                          </div>
                        </div>
                        <div className="bg-card rounded-lg p-3 text-center border border-orange-600/20">
                          <div className="text-[10px] text-muted-foreground">{t('confidential.wholesaleRate')}</div>
                          <div className="text-xl font-bold text-foreground">
                            {d.wholesale_rate != null ? `${d.wholesale_rate.toFixed(1)}%` : '-'}
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                        {d.sales_period && (
                          <>
                            <InfoRow label={t('confidential.salesStart')} value={d.sales_period.start} />
                            <InfoRow label={t('confidential.salesEnd')} value={d.sales_period.end} />
                          </>
                        )}
                        <InfoRow label={t('confidential.orderUnit')} value={d.order_unit} />
                        <InfoRow label={t('confidential.leadTime')} value={d.lead_time} />
                      </div>
                    </CardContent>
                  </Card>

                  {/* Manufacturer */}
                  <Card className="border-border">
                    <CardHeader className="pb-1">
                      <CardTitle className="text-sm font-semibold">{t('manufacturer.title')}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <InfoRow label={t('manufacturer.name')} value={d.manufacturer} />
                      <InfoRow label={t('manufacturer.country')} value={d.manufacturer_country} />
                      <InfoRow label={t('manufacturer.supplier')} value={d.supplier} />
                      <InfoRow label={t('manufacturer.txdManager')} value={d.txd_manager} />
                      {d.sales_channels && (
                        <div className="flex items-center gap-2 py-1">
                          <span className="text-muted-foreground text-xs min-w-[90px] shrink-0">{t('manufacturer.salesChannels')}</span>
                          <div className="flex gap-1">
                            {d.sales_channels.tv && <Badge variant="secondary" className="text-[9px]">{t('manufacturer.tv')}</Badge>}
                            {d.sales_channels.ec && <Badge variant="secondary" className="text-[9px]">{t('manufacturer.ec')}</Badge>}
                            {d.sales_channels.paper && <Badge variant="secondary" className="text-[9px]">{t('manufacturer.paper')}</Badge>}
                            {d.sales_channels.other && <Badge variant="secondary" className="text-[9px]">{t('manufacturer.other')}</Badge>}
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* Supplier Contact */}
                  {d.supplier_contact && (
                    <Card className="border-border">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">{t('supplierContact.title')}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <InfoRow label={t('supplierContact.company')} value={d.supplier_contact.company} />
                        <InfoRow label={t('supplierContact.person')} value={d.supplier_contact.person} />
                        <InfoRow label={t('supplierContact.tel')} value={d.supplier_contact.tel} />
                        <InfoRow label={t('supplierContact.fax')} value={d.supplier_contact.fax} />
                        <InfoRow label={t('supplierContact.email')} value={d.supplier_contact.email} />
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
                    <Card className="border-border">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">{t('contacts.salesDept')}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <InfoRow label={t('supplierContact.company')} value={d.supplier_contact.company} />
                        <InfoRow label={t('supplierContact.person')} value={d.supplier_contact.person} />
                        <InfoRow label={t('supplierContact.tel')} value={d.supplier_contact.tel} />
                        <InfoRow label={t('supplierContact.fax')} value={d.supplier_contact.fax} />
                        <InfoRow label={t('supplierContact.email')} value={d.supplier_contact.email} />
                        <InfoRow label={t('contacts.address')} value={d.supplier_address} />
                      </CardContent>
                    </Card>
                  )}

                  {/* 発注書送付先 */}
                  {d.order_contact && (
                    <Card className="border-border">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">{t('contacts.orderForm')}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <InfoRow label={t('contacts.department')} value={d.order_contact.department} />
                        <InfoRow label={t('supplierContact.person')} value={d.order_contact.person} />
                        <InfoRow label={t('supplierContact.tel')} value={d.order_contact.tel} />
                        <InfoRow label={t('supplierContact.fax')} value={d.order_contact.fax} />
                        <InfoRow label={t('supplierContact.email')} value={d.order_contact.email} />
                      </CardContent>
                    </Card>
                  )}

                  {/* 問合せ先 */}
                  {d.inquiry_contact && (
                    <Card className="border-border">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">{t('contacts.inquiry')}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <InfoRow label={t('contacts.department')} value={d.inquiry_contact.department} />
                        <InfoRow label={t('supplierContact.person')} value={d.inquiry_contact.person} />
                        <InfoRow label={t('supplierContact.tel')} value={d.inquiry_contact.tel} />
                        <InfoRow label={t('supplierContact.fax')} value={d.inquiry_contact.fax} />
                        <InfoRow label={t('supplierContact.email')} value={d.inquiry_contact.email} />
                      </CardContent>
                    </Card>
                  )}

                  {/* 返品商品送付先 */}
                  {d.return_destination && (
                    <Card className="border-orange-600/30 bg-orange-600/10">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold text-orange-700 dark:text-orange-300">{t('contacts.returnDest')}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <InfoRow label={t('supplierContact.company')} value={d.return_destination.company} />
                        <InfoRow label={t('supplierContact.person')} value={d.return_destination.person} />
                        <InfoRow label={t('supplierContact.tel')} value={d.return_destination.tel} />
                        <InfoRow label={t('contacts.address')} value={d.return_destination.address} />
                      </CardContent>
                    </Card>
                  )}

                  {/* 出荷元 */}
                  {d.shipper_info && (
                    <Card className="border-border">
                      <CardHeader className="pb-1">
                        <CardTitle className="text-sm font-semibold">{t('contacts.shipper')}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <InfoRow label={t('supplierContact.company')} value={d.shipper_info.company} />
                        <InfoRow label={t('supplierContact.person')} value={d.shipper_info.person} />
                        <InfoRow label={t('supplierContact.tel')} value={d.shipper_info.tel} />
                        <InfoRow label={t('supplierContact.email')} value={d.shipper_info.email} />
                      </CardContent>
                    </Card>
                  )}

                  {!d.supplier_contact && !d.order_contact && !d.return_destination && !d.shipper_info && (
                    <div className="text-center py-6 text-sm text-muted-foreground">{t('contacts.empty')}</div>
                  )}
                </div>
              )}

              {/* ========== TAB: 商品画像 ========== */}
              {activeTab === 'images' && (
                <>
                  {images.length === 0 && (
                    <div className="py-4 px-5 text-sm bg-amber-600/10 border border-amber-600/30 rounded-xl">
                      <p className="font-medium text-amber-700 dark:text-amber-300">{t('images.emptyTitle')}</p>
                      <p className="text-amber-700/80 dark:text-amber-300/80 text-xs mt-1">
                        {!d
                          ? t('images.emptyNoLedger')
                          : t('images.emptyExtractionFailed')}
                      </p>
                    </div>
                  )}
                  {images.length > 0 && (() => {
                    const grouped = new Map<string, { img: ImageData; flatIndex: number }[]>();
                    for (let fi = 0; fi < images.length; fi++) {
                      const img = images[fi];
                      const key = img.sheet_name ?? t('images.uncategorized');
                      if (!grouped.has(key)) grouped.set(key, []);
                      grouped.get(key)!.push({ img, flatIndex: fi });
                    }
                    return Array.from(grouped.entries()).map(([sheetName, items]) => (
                      <Card key={sheetName} className="border-border">
                        <CardHeader className="pb-1">
                          <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                            <ImageIcon size={14} /> {sheetName}
                            <span className="text-xs font-normal text-muted-foreground">({t('images.count', { count: items.length })})</span>
                          </CardTitle>
                        </CardHeader>
                        <CardContent>
                          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                            {items.map(({ img, flatIndex }) => (
                              <button
                                key={img.id}
                                type="button"
                                onClick={() => setLightboxIndex(flatIndex)}
                                className="aspect-square rounded-lg overflow-hidden border border-border hover:border-blue-400 hover:shadow-md transition-all bg-muted cursor-pointer"
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
                  ref={lightboxRef}
                  role="dialog"
                  aria-modal="true"
                  aria-label={t('lightboxLabel')}
                  className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 outline-none"
                  onClick={() => setLightboxIndex(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft' && lightboxIndex > 0) setLightboxIndex(lightboxIndex - 1);
                    if (e.key === 'ArrowRight' && lightboxIndex < images.length - 1) setLightboxIndex(lightboxIndex + 1);
                    if (e.key === 'Escape') setLightboxIndex(null);
                  }}
                  tabIndex={-1}
                >
                  {/* Close */}
                  <button
                    type="button"
                    aria-label={t('lightboxClose')}
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
                      aria-label={t('lightboxPrev')}
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
                      aria-label={t('lightboxNext')}
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
                <div className="py-4 px-5 text-sm bg-amber-600/10 border border-amber-600/30 rounded-xl">
                  <p className="font-medium text-amber-700 dark:text-amber-300">{t('ledgerMissing.title')}</p>
                  <p className="text-amber-700/80 dark:text-amber-300/80 text-xs mt-1">{t('ledgerMissing.tabDescription')}</p>
                </div>
              )}

              {/* Data source footer */}
              {d?.source_file && (
                <div className="text-[10px] text-muted-foreground text-right pt-2 border-t border-border">
                  {t('source')}: {d.source_file} {d.file_date ? `(${d.file_date})` : ''}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
