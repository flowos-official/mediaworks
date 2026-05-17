"use client";

import { useTranslations } from "next-intl";
import BroadcastListItem, { type Broadcast } from "./BroadcastListItem";
import ChannelFilter, { type ChannelFilterValue } from "./ChannelFilter";

// Whitelist categories per channel — mirrors channel_categories seed (Phase 1-C).
const CATEGORIES_BY_CHANNEL: Record<"qvc" | "shopch", readonly string[]> = {
  qvc: [
    "ビューティー",
    "ファッション小物",
    "健康・ダイエット",
    "ホーム",
    "キッチングッズ",
    "レジャー・ホビー",
    "家電",
  ],
  shopch: [
    "靴・バッグ・小物・インナー",
    "コスメ",
    "美容・ダイエット・フィットネス",
    "ホーム・インテリア",
    "家電",
  ],
};

interface Props {
  date: string | null;
  broadcasts: Broadcast[];
  channelFilter: ChannelFilterValue;
  onChannelFilterChange: (v: ChannelFilterValue) => void;
  categoryFilter: string;
  onCategoryFilterChange: (v: string) => void;
}

function formatDateLabel(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${y}年${parseInt(m, 10)}月${parseInt(d, 10)}日`;
}

export default function DayDetailPanel({
  date,
  broadcasts,
  channelFilter,
  onChannelFilterChange,
  categoryFilter,
  onCategoryFilterChange,
}: Props) {
  const t = useTranslations("broadcasts");

  if (!date) {
    return (
      <div className="text-sm text-gray-500 p-6 text-center">
        {t("empty.day")}
      </div>
    );
  }

  // "全カテゴリ" still narrows to the per-channel whitelist so non-whitelist
  // slots (e.g. ジュエリー, グルメ・お酒) collected for analytics don't show in
  // the default operator view. A specific chip selection is exact-match.
  const filtered = broadcasts.filter((b) => {
    if (channelFilter !== "all" && b.channel !== channelFilter) return false;
    if (categoryFilter === "all") {
      if (!b.category) return false;
      const wl = CATEGORIES_BY_CHANNEL[b.channel];
      return wl.includes(b.category);
    }
    return b.category === categoryFilter;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (a.start_time !== b.start_time) return a.start_time.localeCompare(b.start_time);
    return a.channel.localeCompare(b.channel);
  });

  // Show categories from the active channel filter, or both channels' merged set when "all".
  const visibleCategories =
    channelFilter === "all"
      ? Array.from(
          new Set([...CATEGORIES_BY_CHANNEL.qvc, ...CATEGORIES_BY_CHANNEL.shopch]),
        )
      : CATEGORIES_BY_CHANNEL[channelFilter];

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3 flex-wrap gap-2">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{formatDateLabel(date)}</h2>
          <p className="text-xs text-gray-500">
            {t("broadcastCount", { count: filtered.length })}
          </p>
        </div>
        <ChannelFilter value={channelFilter} onChange={onChannelFilterChange} />
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        <button
          type="button"
          onClick={() => onCategoryFilterChange("all")}
          className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
            categoryFilter === "all"
              ? "bg-gray-900 text-white border-gray-900"
              : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
          }`}
        >
          {t("categoryFilter.all")}
        </button>
        {visibleCategories.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => onCategoryFilterChange(c)}
            className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
              categoryFilter === c
                ? "bg-gray-900 text-white border-gray-900"
                : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {sorted.length === 0 ? (
        <div className="text-sm text-gray-500 p-6 text-center border border-dashed border-gray-200 rounded-lg">
          {broadcasts.length === 0 ? t("empty.day") : t("empty.filtered")}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map((b) => (
            <BroadcastListItem key={b.id} broadcast={b} />
          ))}
        </div>
      )}
    </div>
  );
}
