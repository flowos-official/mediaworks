"use client";

import { useTranslations } from "next-intl";

export type ChannelFilterValue = "all" | "shopch" | "qvc";

interface Props {
  value: ChannelFilterValue;
  onChange: (v: ChannelFilterValue) => void;
}

const OPTIONS: ChannelFilterValue[] = ["all", "shopch", "qvc"];

const STYLES: Record<ChannelFilterValue, { active: string; inactive: string }> = {
  all: {
    active: "bg-gray-900 text-white border-gray-900",
    inactive: "bg-white text-gray-700 border-gray-300 hover:bg-gray-50",
  },
  shopch: {
    active: "bg-red-600 text-white border-red-600",
    inactive: "bg-white text-red-700 border-red-300 hover:bg-red-50",
  },
  qvc: {
    active: "bg-violet-600 text-white border-violet-600",
    inactive: "bg-white text-violet-700 border-violet-300 hover:bg-violet-50",
  },
};

export default function ChannelFilter({ value, onChange }: Props) {
  const t = useTranslations("broadcasts");
  return (
    <div className="inline-flex items-center gap-2">
      {OPTIONS.map((opt) => {
        const active = value === opt;
        const style = STYLES[opt][active ? "active" : "inactive"];
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={`px-3 py-1 rounded-full text-xs font-medium border ${style} transition-colors`}
          >
            {t(`filters.${opt}`)}
          </button>
        );
      })}
    </div>
  );
}
