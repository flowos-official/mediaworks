// components/screenplay/VersionProvenance.tsx
import { useTranslations } from "next-intl";

interface Props {
  model: string | null;
  patternSampleSize: number | null;
}

export function VersionProvenance({ model, patternSampleSize }: Props) {
  const t = useTranslations("screenplay");
  if (!model && !patternSampleSize) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {model ? <span>{t("provenanceModel", { model })}</span> : null}
      {/* Positive case only — a version generated before this feature (or a
          refine, which never receives a pattern block) has no snapshot, and
          that must render nothing rather than a new negative caption on
          every pre-existing and refine version. */}
      {patternSampleSize ? <span>{t("patternApplied", { count: patternSampleSize })}</span> : null}
    </div>
  );
}
