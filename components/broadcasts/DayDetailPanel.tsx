"use client";

import { useTranslations } from "next-intl";
import BroadcastListItem, { type Broadcast } from "./BroadcastListItem";
import ChannelFilter, { type ChannelFilterValue } from "./ChannelFilter";

interface Props {
  date: string | null;
  broadcasts: Broadcast[];
  channelFilter: ChannelFilterValue;
  onChannelFilterChange: (v: ChannelFilterValue) => void;
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
}: Props) {
  const t = useTranslations("broadcasts");

  if (!date) {
    return (
      <div className="text-sm text-gray-500 p-6 text-center">
        {t("empty.day")}
      </div>
    );
  }

  const filtered =
    channelFilter === "all"
      ? broadcasts
      : broadcasts.filter((b) => b.channel === channelFilter);

  const sorted = [...filtered].sort((a, b) => {
    if (a.start_time !== b.start_time) return a.start_time.localeCompare(b.start_time);
    return a.channel.localeCompare(b.channel);
  });

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
