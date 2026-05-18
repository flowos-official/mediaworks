import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/require-user";
import BroadcastCalendar from "@/components/broadcasts/BroadcastCalendar";
import BroadcastSearchOverlay from "@/components/broadcasts/BroadcastSearchOverlay";
import type { Broadcast } from "@/components/broadcasts/BroadcastListItem";
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

  // Auth gate: /broadcasts is member/admin only. Use auth.sb so RLS applies.
  // Per CLAUDE.md: getServiceClient is reserved for cron/workflow paths.
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) {
    redirect(localePath(locale, "/login"));
  }
  const sb = auth.sb;

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const selected = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : todayIso;
  const { y, m, from, to } = monthBoundsAround(selected);

  const { data } = await sb
    .from("broadcasts")
    .select(
      "id,channel,air_date,start_time,program_title,presenter,description,thumbnail_url,source_url,product_ids,category",
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
    category: string | null;
  }>;
  const productMap = await loadProductsForBroadcasts(rows);

  const initialBroadcasts: Broadcast[] = rows.map((r) => ({
    ...r,
    products: productMap.get(r.id) ?? null,
  }));

  // Per-channel total counts (across all dates) drive the chip "(N)" labels
  // in the bottom search panel. QVC/ShopCh counts come from `broadcasts`;
  // OA counts come from `historical_broadcasts`. All searches client-side
  // span both tables.
  const oaCountResults = await Promise.all(
    OA_CHANNEL_SLUGS.map(async (slug) => {
      const { count } = await sb
        .from("historical_broadcasts")
        .select("id", { count: "exact", head: true })
        .eq("channel", slug);
      return [slug, count ?? 0] as const;
    }),
  );
  const tvCountResults = await Promise.all(
    (["qvc", "shopch"] as const).map(async (slug) => {
      const { count } = await sb
        .from("broadcasts")
        .select("id", { count: "exact", head: true })
        .eq("channel", slug);
      return [slug, count ?? 0] as const;
    }),
  );
  const channelCounts: Record<string, number> = Object.fromEntries([
    ...tvCountResults,
    ...oaCountResults,
  ]);

  const hasAny = initialBroadcasts.length > 0;

  return (
    <>
      <div className="flex justify-end mb-6">
        <BroadcastSearchOverlay channelCounts={channelCounts} />
      </div>

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
    </>
  );
}
