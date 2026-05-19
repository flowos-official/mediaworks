"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Broadcast } from "./BroadcastListItem";
import UnifiedDayDetailPanel from "./UnifiedDayDetailPanel";
import MonthGrid from "./MonthGrid";

interface Props {
  initialYear: number;
  initialMonth: number;
  initialDate: string | null;
  initialBroadcasts: Broadcast[];
}

function monthKey(y: number, m: number) {
  return `${y}-${String(m).padStart(2, "0")}`;
}

function gridBounds(y: number, m: number): { from: string; to: string } {
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const prevLast = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
  const nextLast = new Date(Date.UTC(nextY, nextM, 0)).getUTCDate();
  return {
    from: `${prevY}-${String(prevM).padStart(2, "0")}-${String(Math.max(prevLast - 6, 1)).padStart(2, "0")}`,
    to: `${nextY}-${String(nextM).padStart(2, "0")}-${String(Math.min(nextLast, 7)).padStart(2, "0")}`,
  };
}

export default function BroadcastCalendar({
  initialYear,
  initialMonth,
  initialDate,
  initialBroadcasts,
}: Props) {
  const t = useTranslations("broadcasts");
  const router = useRouter();

  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);
  const [selectedDate, setSelectedDate] = useState<string | null>(initialDate);

  const initialKey = monthKey(initialYear, initialMonth);
  const [cache, setCache] = useState<Map<string, Broadcast[]>>(
    () => new Map([[initialKey, initialBroadcasts]]),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentKey = monthKey(year, month);
  const currentMonthData = useMemo(
    () => cache.get(currentKey) ?? [],
    [cache, currentKey],
  );

  useEffect(() => {
    if (cache.has(currentKey)) return;
    const { from, to } = gridBounds(year, month);
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        // limit=2000 covers gridBounds' 45-day window (~1,400 broadcasts).
        // Without it the API default (200) returns only ~8 days of data and
        // most month-grid cells render empty.
        const r = await fetch(`/api/broadcasts?from=${from}&to=${to}&limit=2000`, {
          signal: controller.signal,
        });
        if (!r.ok) throw new Error(r.statusText);
        const json = (await r.json()) as { broadcasts: Broadcast[] };
        setCache((prev) => new Map(prev).set(currentKey, json.broadcasts));
      } catch (e) {
        if ((e as { name?: string }).name !== "AbortError") {
          setError(String(e));
        }
      } finally {
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [currentKey, year, month, cache]);

  // URL only carries the selected date now. Channel/category state moved
  // into UnifiedDayDetailPanel and is no longer shared with the page URL.
  const syncUrl = useCallback(
    (date: string | null) => {
      const params = new URLSearchParams();
      if (date) params.set("date", date);
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router],
  );

  const handleDateClick = useCallback(
    (iso: string) => {
      setSelectedDate(iso);
      const [y, m] = iso.split("-").map((x) => parseInt(x, 10));
      if (y !== year || m !== month) {
        setYear(y);
        setMonth(m);
      }
      syncUrl(iso);
    },
    [year, month, syncUrl],
  );

  // Month nav stays purely client-side — useEffect above auto-fetches the
  // new month's data via `/api/broadcasts?from=&to=` when it's missing from
  // cache. Earlier attempt to also syncUrl on month-change caused the server
  // component to re-render with stale state and broke the next-month return
  // (the new initialBroadcasts didn't update useState cache).
  const goPrev = useCallback(() => {
    if (month === 1) {
      setYear(year - 1);
      setMonth(12);
    } else {
      setMonth(month - 1);
    }
    setSelectedDate(null);
  }, [year, month]);

  const goNext = useCallback(() => {
    if (month === 12) {
      setYear(year + 1);
      setMonth(1);
    } else {
      setMonth(month + 1);
    }
    setSelectedDate(null);
  }, [year, month]);

  const monthLabel = `${year}年 ${month}月`;

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div>
        <div className="flex items-center justify-between mb-3">
          <button
            type="button"
            onClick={goPrev}
            className="p-1.5 rounded hover:bg-gray-100"
            aria-label={t("monthNav.prev")}
          >
            <ChevronLeft size={18} />
          </button>
          <h2 className="text-lg font-semibold text-gray-900">{monthLabel}</h2>
          <button
            type="button"
            onClick={goNext}
            className="p-1.5 rounded hover:bg-gray-100"
            aria-label={t("monthNav.next")}
          >
            <ChevronRight size={18} />
          </button>
        </div>
        {loading && (
          <div className="text-xs text-gray-500 mb-2">Loading…</div>
        )}
        {error && (
          <div className="text-xs text-red-600 mb-2">
            {t("empty.apiError")} ({error})
          </div>
        )}
        <MonthGrid
          year={year}
          month={month}
          broadcasts={currentMonthData}
          selectedDate={selectedDate}
          onDateClick={handleDateClick}
        />
      </div>

      <div className="md:max-h-[calc(100vh-12rem)] md:overflow-y-auto md:sticky md:top-4 pr-1">
        <UnifiedDayDetailPanel date={selectedDate} />
      </div>
    </div>
  );
}
