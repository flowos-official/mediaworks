import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth/require-user";
import { localePath } from "@/lib/i18n/locale-path";
import RetryButton from "./RetryButton";
import TriggerDetectionButton from "./TriggerDetectionButton";
import { filterMarketRecords } from "@/lib/market/data-visibility";

export const dynamic = "force-dynamic";

const KNOWN_REASONS = new Set([
	"safety_blocked",
	"rate_limited",
	"server_error",
	"parse_failed",
	"schema_validation_failed",
	"extract_empty",
	"context_load_failed",
	"cron_secret_missing",
	"trigger_not_invoked",
	"analysis_timeout",
	"extract_failed",
	"synthesis_failed",
	"file_too_large",
	"no_files",
	"unknown",
]);

interface PageProps {
  params: Promise<{ locale: string }>;
}

interface PipelineRow {
  id: string;
  name: string;
  status: "analyzing" | "failed";
  error_reason: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function minutesAgo(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

export default async function ResearchPipelinePage({ params }: PageProps) {
  const { locale } = await params;
  const auth = await requireUser(["admin"]);
  if ("error" in auth) redirect(localePath(locale, "/login"));
  const sb = auth.sb;
  const t = await getTranslations("admin.researchPipeline");
  const reasonLabel = (reason: string | null): string => {
    if (!reason) return t("reasonUnknown");
    const kind = reason.split(":")[0].trim();
    return KNOWN_REASONS.has(kind) ? t(`reason.${kind}`) : kind;
  };

  const { data: rows } = await sb
    .from("products")
    .select("id, name, status, error_reason, description, created_at, updated_at")
    .in("status", ["analyzing", "failed"])
    .order("updated_at", { ascending: false })
    .limit(100);

  const products = filterMarketRecords((rows ?? []) as PipelineRow[]);
  const analyzing = products.filter((r) => r.status === "analyzing");
  const failed = products.filter((r) => r.status === "failed");

	return (
		<div className="space-y-5">
			<header className="mw-panel px-4 py-4 sm:px-5">
				<div className="mw-kicker mb-1">Queue health</div>
				<h2 className="text-xl font-bold tracking-[-0.02em]">{t("title")}</h2>
			</header>

			<section className="mw-panel p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-sm font-medium">{t("manualDetect.title")}</div>
            <div className="text-xs text-muted-foreground">
              {t("manualDetect.hint")}
            </div>
          </div>
          <TriggerDetectionButton />
        </div>
      </section>

			<section className="space-y-2">
				<h2 className="mw-section-title">
          {t("analyzingHeading", { count: analyzing.length })}
        </h2>
        {analyzing.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("none")}</p>
        ) : (
          <ul className="space-y-2">
            {analyzing.map((p) => (
							<li key={p.id} className="mw-panel flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {t("startedAt", { time: p.created_at.slice(11, 16), mins: minutesAgo(p.updated_at) })}
                  </div>
                </div>
                <RetryButton productId={p.id} label={t("retryForce")} />
              </li>
            ))}
          </ul>
        )}
      </section>

			<section className="space-y-2">
				<h2 className="mw-section-title">{t("failedHeading", { count: failed.length })}</h2>
        {failed.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("none")}</p>
        ) : (
          <ul className="space-y-2">
            {failed.map((p) => (
							<li key={p.id} className="mw-panel flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {reasonLabel(p.error_reason)} · {p.error_reason ?? t("reasonUnknown")} · {t("failedTimeLabel")}: {p.updated_at.slice(11, 16)}
                    {p.description == null ? ` · ${t("descMissing")}` : ""}
                  </div>
                </div>
                <RetryButton productId={p.id} label={t("retry")} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
