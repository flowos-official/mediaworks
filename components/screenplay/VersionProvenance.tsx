// components/screenplay/VersionProvenance.tsx
import { useTranslations } from "next-intl";

interface Props {
  model: string | null;
  patternSampleSize: number | null;
}

export function VersionProvenance({ model, patternSampleSize }: Props) {
  const t = useTranslations("screenplay");
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {model ? <span>{t("provenanceModel", { model })}</span> : null}
      <span>
        {patternSampleSize
          ? t("patternApplied", { count: patternSampleSize })
          : t("patternNone")}
      </span>
    </div>
  );
}
