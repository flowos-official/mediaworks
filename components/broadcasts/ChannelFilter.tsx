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
    active: "bg-foreground text-background border-foreground",
    inactive: "bg-card text-foreground border-border hover:bg-muted",
  },
  shopch: {
    active: "bg-red-600 text-white border-red-600",
    inactive: "bg-card text-red-700 dark:text-red-300 border-red-500/40 hover:bg-red-600/10",
  },
  qvc: {
    active: "bg-violet-600 text-white border-violet-600",
    inactive: "bg-card text-violet-700 dark:text-violet-300 border-violet-500/40 hover:bg-violet-600/10",
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
