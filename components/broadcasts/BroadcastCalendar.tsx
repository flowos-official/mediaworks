"use client";

import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { Broadcast } from "./BroadcastListItem";
import type { ChannelFilterValue } from "./ChannelFilter";
import DayDetailPanel from "./DayDetailPanel";
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
  const searchParams = useSearchParams();

  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);
  const [selectedDate, setSelectedDate] = useState<string | null>(initialDate);
  const [channelFilter, setChannelFilter] = useState<ChannelFilterValue>(
    (searchParams.get("ch") as ChannelFilterValue) ?? "all",
  );
  const [categoryFilter, setCategoryFilter] = useState<string>(
    searchParams.get("cat") ?? "all",
  );

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
        const r = await fetch(`/api/broadcasts?from=${from}&to=${to}`, {
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

  const syncUrl = useCallback(
    (date: string | null, ch: ChannelFilterValue, cat: string) => {
      const params = new URLSearchParams();
      if (date) params.set("date", date);
      if (ch !== "all") params.set("ch", ch);
      if (cat !== "all") params.set("cat", cat);
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
      syncUrl(iso, channelFilter, categoryFilter);
    },
    [year, month, channelFilter, categoryFilter, syncUrl],
  );

  const handleFilterChange = useCallback(
    (v: ChannelFilterValue) => {
      setChannelFilter(v);
      // Reset category when changing channel — categories are per-channel.
      const nextCat = v === "all" ? categoryFilter : "all";
      if (nextCat !== categoryFilter) setCategoryFilter(nextCat);
      syncUrl(selectedDate, v, nextCat);
    },
    [selectedDate, categoryFilter, syncUrl],
  );

  const handleCategoryFilterChange = useCallback(
    (v: string) => {
      setCategoryFilter(v);
      syncUrl(selectedDate, channelFilter, v);
    },
    [selectedDate, channelFilter, syncUrl],
  );

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

  const dayBroadcasts = useMemo(
    () =>
      selectedDate
        ? currentMonthData.filter((b) => b.air_date === selectedDate)
        : [],
    [selectedDate, currentMonthData],
  );

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

      <div>
        <DayDetailPanel
          date={selectedDate}
          broadcasts={dayBroadcasts}
          channelFilter={channelFilter}
          onChannelFilterChange={handleFilterChange}
          categoryFilter={categoryFilter}
          onCategoryFilterChange={handleCategoryFilterChange}
        />
      </div>
    </div>
  );
}
