// components/screenplay/VersionProvenance.tsx
import { useTranslations } from "next-intl";
import type { PatternLoadStatus } from "@/lib/screenplay/context/pattern-result";

interface Props {
  model: string | null;
  patternSampleSize: number | null;
  /** Null for a version generated before the generation-context table, and for
   *  imports. Those render "provenance unavailable" — NOT a negative pattern
   *  caption, which would assert that a lookup happened and came back empty. */
  patternStatus?: PatternLoadStatus | null;
  claimsNeedingReview?: number | null;
}

/** Every non-applied status is shown. The whole reason the column exists is
 *  that "no competitor pattern" was previously indistinguishable from "the
 *  lookup timed out" and from "the feature is switched off". */
const NEGATIVE_STATUSES: PatternLoadStatus[] = [
  "disabled",
  "no_category",
  "off_whitelist",
  "under_sampled",
  "timed_out",
  "failed",
];

export function VersionProvenance({
  model,
  patternSampleSize,
  patternStatus = null,
  claimsNeedingReview = null,
}: Props) {
  const t = useTranslations("screenplay");
  const showPattern = patternStatus !== null;
  if (!model && !patternSampleSize && !showPattern && !claimsNeedingReview) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {model ? <span>{t("provenanceModel", { model })}</span> : null}

      {patternStatus === "applied" && patternSampleSize ? (
        <span>{t("patternApplied", { count: patternSampleSize })}</span>
      ) : null}

      {patternStatus && NEGATIVE_STATUSES.includes(patternStatus) ? (
        <span>{t(`patternStatus.${patternStatus}`)}</span>
      ) : null}

      {/* No context at all: legacy version or an import. Says so rather than
          leaving the reader to infer that nothing was found. */}
      {!showPattern && patternSampleSize ? (
        <span>{t("patternApplied", { count: patternSampleSize })}</span>
      ) : null}

      {claimsNeedingReview ? (
        <span className="text-red-600">{t("claimsNeedingReview", { count: claimsNeedingReview })}</span>
      ) : null}
    </div>
  );
}
