"use client";

interface Props {
  iso: string;
  dayLabel: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isSelected: boolean;
  shopchCount: number;
  qvcCount: number;
  onClick: (iso: string) => void;
}

export default function DateCell({
  iso,
  dayLabel,
  isCurrentMonth,
  isToday,
  isSelected,
  shopchCount,
  qvcCount,
  onClick,
}: Props) {
  const total = shopchCount + qvcCount;
  const base = "aspect-square rounded-lg p-1.5 text-left transition-colors border";
  const muted = !isCurrentMonth;
  const selected = isSelected;
  const todayRing = isToday && !selected;

  const cls = [
    base,
    selected
      ? "bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
      : muted
        ? "bg-gray-50 text-gray-400 border-gray-100 hover:bg-gray-100"
        : "bg-white text-gray-900 border-gray-200 hover:bg-gray-50",
    todayRing ? "ring-2 ring-blue-400" : "",
  ].join(" ");

  return (
    <button type="button" onClick={() => onClick(iso)} className={cls}>
      <div className="text-sm font-semibold leading-tight">{dayLabel}</div>
      {total > 0 ? (
        <div className={`text-[10px] leading-tight mt-1 ${selected ? "text-blue-100" : "text-gray-500"}`}>
          <div>S·{shopchCount}</div>
          <div>Q·{qvcCount}</div>
        </div>
      ) : (
        <div className={`text-[10px] leading-tight mt-1 ${selected ? "text-blue-200" : "text-gray-300"}`}>—</div>
      )}
    </button>
  );
}
