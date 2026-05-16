import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getServiceClient } from "@/lib/supabase";
import BroadcastCalendar from "@/components/broadcasts/BroadcastCalendar";
import HistoricalBroadcasts from "@/components/broadcasts/HistoricalBroadcasts";
import type { Broadcast } from "@/components/broadcasts/BroadcastListItem";
import type { HistoricalBroadcastRow } from "@/app/api/historical-broadcasts/route";
import { loadProductsForBroadcasts } from "@/lib/qvc-products/attach";
import { localePath } from "@/lib/i18n/locale-path";

const OA_CHANNEL_SLUGS = [
  "japanet",
  "junsanpo",
  "ntv",
  "tbs",
  "dinos",
  "senobura",
  "uranoura",
  "btops",
] as const;

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ date?: string; ch?: string }>;
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function monthBoundsAround(iso: string): { y: number; m: number; from: string; to: string } {
  const [yy, mm] = iso.split("-").map((x) => parseInt(x, 10));
  const prevY = mm === 1 ? yy - 1 : yy;
  const prevM = mm === 1 ? 12 : mm - 1;
  const nextY = mm === 12 ? yy + 1 : yy;
  const nextM = mm === 12 ? 1 : mm + 1;
  const prevLast = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
  const nextLast = new Date(Date.UTC(nextY, nextM, 0)).getUTCDate();
  return {
    y: yy,
    m: mm,
    from: `${prevY}-${pad2(prevM)}-${pad2(Math.max(prevLast - 6, 1))}`,
    to: `${nextY}-${pad2(nextM)}-${pad2(Math.min(nextLast, 7))}`,
  };
}

export default async function Page({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const sp = await searchParams;
  const t = await getTranslations({ locale, namespace: "broadcasts" });

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const selected = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayIso;
  const { y, m, from, to } = monthBoundsAround(selected);

  const sb = getServiceClient();
  const { data } = await sb
    .from("broadcasts")
    .select(
      "id,channel,air_date,start_time,program_title,presenter,description,thumbnail_url,source_url,product_ids",
    )
    .gte("air_date", from)
    .lte("air_date", to)
    .order("air_date", { ascending: true })
    .order("start_time", { ascending: true })
    .order("channel", { ascending: true });

  const rows = (data ?? []) as Array<{
    id: string;
    channel: "shopch" | "qvc";
    air_date: string;
    start_time: string;
    program_title: string;
    presenter: string | null;
    description: string | null;
    thumbnail_url: string | null;
    source_url: string;
    product_ids: string[] | null;
  }>;
  const productMap = await loadProductsForBroadcasts(rows);

  const initialBroadcasts: Broadcast[] = rows.map((r) => ({
    ...r,
    products: productMap.get(r.id) ?? null,
  }));

  // Excel-imported rows span 2020-04 ~ today; per-channel counts cover the whole history.
  // The list view is scoped to the calendar's selected date only.
  const [{ data: historicalData, count: historicalTotal }, channelCountResults] =
    await Promise.all([
      sb
        .from("historical_broadcasts")
        .select(
          "id,channel,air_date,day_of_week,product_name,price_text,price_jpy,price_is_tax_incl,source_url",
          { count: "exact" },
        )
        .eq("air_date", selected)
        .order("channel", { ascending: true })
        .range(0, 49),
      Promise.all(
        OA_CHANNEL_SLUGS.map(async (slug) => {
          const { count } = await sb
            .from("historical_broadcasts")
            .select("id", { count: "exact", head: true })
            .eq("channel", slug);
          return [slug, count ?? 0] as const;
        }),
      ),
    ]);

  const initialHistorical = (historicalData ?? []) as HistoricalBroadcastRow[];
  const channelCounts: Record<string, number> = Object.fromEntries(channelCountResults);

  const hasAny = initialBroadcasts.length > 0;

  return (
    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <header className="mb-6">
        <Link
          href={localePath(locale)}
          className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-3"
        >
          <ArrowLeft size={16} />
          {t("back")}
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">{t("title")}</h1>
        <p className="text-sm text-gray-500 mt-1">{t("subtitle")}</p>
      </header>

      {!hasAny ? (
        <div className="text-sm text-gray-500 p-12 text-center border border-dashed border-gray-200 rounded-lg">
          {t("empty.all")}
        </div>
      ) : (
        <BroadcastCalendar
          initialYear={y}
          initialMonth={m}
          initialDate={selected}
          initialBroadcasts={initialBroadcasts}
        />
      )}

      <HistoricalBroadcasts
        initialRows={initialHistorical}
        initialTotal={historicalTotal ?? 0}
        initialDate={selected}
        channelCounts={channelCounts}
      />
    </main>
  );
}
