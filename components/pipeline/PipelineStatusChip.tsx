"use client";
import Link from "next/link";
import { ClipboardList } from "lucide-react";
import { useTranslations } from "next-intl";

type Stage = "selected" | "sourcing" | "scheduled" | "closed";

const TONE: Record<Stage, string> = {
  selected:  "bg-neutral-600/15 text-neutral-700 dark:text-neutral-300",
  sourcing:  "bg-amber-600/15 text-amber-700 dark:text-amber-300",
  scheduled: "bg-blue-600/15 text-blue-700 dark:text-blue-300",
  closed:    "bg-emerald-600/15 text-emerald-700 dark:text-emerald-300",
};

export function PipelineStatusChip({
  selectionId, stage,
}: { selectionId: string; stage: Stage }) {
  const t = useTranslations("pipeline");
  return (
    <Link
      href={`/analytics/pipeline?focus=${selectionId}`}
      className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold ${TONE[stage]}`}
    >
      <ClipboardList size={10} />
      <span>{t("title")}: {t(`status.${stage}`)}</span>
    </Link>
  );
}
