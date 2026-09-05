"use client";

/**
 * What this version was written from.
 *
 * The point of the panel is the negative space. A pattern that did not apply
 * gets a line saying which of the five reasons applied; a fact we never held
 * gets named as missing; a legacy version says its context is unavailable
 * rather than rendering an empty, satisfied-looking state.
 */
import { useTranslations } from "next-intl";
import type { ScreenplayGenerationContext } from "@/lib/screenplay/context/build";
import type { FactUsage } from "@/lib/screenplay/context/types";

const USAGE_TONE: Record<FactUsage, string> = {
	direct: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-300",
	attributed_only: "bg-amber-600/10 text-amber-700 dark:text-amber-300",
	planning_only: "bg-muted text-muted-foreground",
};

export type ContextTab = "facts" | "references" | "outline" | "demo";

function formatValue(value: unknown): string {
	if (value === null || value === undefined) return "—";
	if (typeof value === "string") return value;
	if (typeof value === "number") return value.toLocaleString("ja-JP");
	return JSON.stringify(value);
}

export function GenerationContextUnavailable() {
	const t = useTranslations("screenplay.context");
	return (
		<p className="rounded-lg border border-dashed border-border px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
			{t("unavailable")}
		</p>
	);
}

export function GenerationContextPanel({
	context,
	tab,
}: {
	context: ScreenplayGenerationContext | null;
	tab: ContextTab;
}) {
	const t = useTranslations("screenplay.context");
	if (!context) return <GenerationContextUnavailable />;

	const { productFactPack: pack, referenceBroadcasts, patternResult, structurePlan } = context;

	if (tab === "facts") {
		return (
			<div className="space-y-3">
				<ul className="space-y-1.5">
					{pack.facts.map((fact) => (
						<li key={fact.key} className="rounded-lg border border-border bg-background p-2.5">
							<div className="flex items-center justify-between gap-2">
								<span className="text-[11px] font-medium text-foreground">{fact.label}</span>
								<span className={`rounded px-1.5 py-0.5 text-[10px] ${USAGE_TONE[fact.usage]}`}>
									{t(`usage.${fact.usage}`)}
								</span>
							</div>
							<p className="mt-1 break-words text-[11px] text-muted-foreground">
								{formatValue(fact.value)}
								{fact.unit ? ` ${fact.unit}` : ""}
							</p>
							<p className="mt-1 font-mono text-[10px] text-muted-foreground">
								{fact.evidenceClass} · {fact.sourceLabel} · {fact.observedAt.slice(0, 10)}
							</p>
						</li>
					))}
				</ul>

				{/* Named, never omitted. A gap that is not shown reads as "not
				    relevant to this product". */}
				{pack.missing.length > 0 && (
					<div className="rounded-lg border border-dashed border-amber-600/40 p-2.5">
						<p className="text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
							{t("missing")}
						</p>
						<p className="mt-1 text-[11px] text-muted-foreground">{pack.missing.join(" · ")}</p>
					</div>
				)}
			</div>
		);
	}

	if (tab === "references") {
		return (
			<div className="space-y-3">
				<div
					className={`rounded-lg border p-2.5 ${
						patternResult.status === "applied" ? "border-emerald-600/40" : "border-dashed border-border"
					}`}
				>
					<p className="text-[11px] font-medium text-foreground">
						{t(`patternStatus.${patternResult.status}`)}
					</p>
					{/* The reason, verbatim from the run. Without it "no pattern" is
					    the same on screen as "the lookup timed out". */}
					<p className="mt-1 break-words font-mono text-[10px] text-muted-foreground">
						{patternResult.detail}
					</p>
					{patternResult.pattern && (
						<p className="mt-1 text-[11px] text-muted-foreground">
							{t("patternSample", {
								count: patternResult.pattern.sampleSize,
								channels: patternResult.pattern.channels.join(" / "),
							})}
						</p>
					)}
				</div>

				{referenceBroadcasts.length === 0 ? (
					<p className="text-[11px] text-muted-foreground">{t("noReferences")}</p>
				) : (
					<ul className="space-y-1.5">
						{referenceBroadcasts.map((reference) => (
							<li
								key={reference.broadcastId}
								className="rounded-lg border border-border bg-background p-2.5 text-[11px]"
							>
								<div className="flex items-center justify-between gap-2">
									<span className="font-medium uppercase text-foreground">{reference.channel}</span>
									<span className="font-mono text-[10px] tabular-nums text-muted-foreground">
										{Math.round(reference.similarity * 100)}%
									</span>
								</div>
								<p className="text-muted-foreground">
									{reference.airDate}
									{reference.category ? ` · ${reference.category}` : ""}
								</p>
								<p className="mt-1 text-[10px] text-muted-foreground">
									{t("matchedOn")}:{" "}
									{reference.matchedOn.length > 0
										? reference.matchedOn.map((key) => t(`match.${key}`)).join(" · ")
										: t("match.none")}
								</p>
							</li>
						))}
					</ul>
				)}
			</div>
		);
	}

	if (tab === "outline") {
		return (
			<div className="space-y-2">
				<p className="px-1 text-[10px] text-muted-foreground">
					{t(`basis.${structurePlan.basis}`)} · {t("runtime", { minutes: structurePlan.runtimeMinutes })}
				</p>
				<ol className="space-y-1.5">
					{structurePlan.sections.map((section, index) => (
						<li key={section.id} className="rounded-lg border border-border bg-background p-2.5">
							<div className="flex items-center justify-between gap-2">
								<span className="text-[11px] font-medium text-foreground">
									{String(index + 1).padStart(2, "0")} {section.title}
								</span>
								<span className="font-mono text-[10px] tabular-nums text-muted-foreground">
									{Math.round(section.runtimeShare * 100)}%
								</span>
							</div>
							<p className="mt-1 text-[11px] text-muted-foreground">{section.purpose}</p>
							{section.factKeys.length > 0 && (
								<p className="mt-1 font-mono text-[10px] text-muted-foreground">
									{section.factKeys.join(", ")}
								</p>
							)}
						</li>
					))}
				</ol>
			</div>
		);
	}

	return structurePlan.demos.length === 0 ? (
		<p className="text-[11px] text-muted-foreground">{t("noDemos")}</p>
	) : (
		<ul className="space-y-1.5">
			{structurePlan.demos.map((demo) => (
				<li key={demo.id} className="rounded-lg border border-border bg-background p-2.5 text-[11px]">
					<p className="font-medium text-foreground">{demo.title}</p>
					<p className="mt-1 text-muted-foreground">{demo.hostAction}</p>
					<p className="mt-1 font-mono text-[10px] text-muted-foreground">📷 {demo.cameraCue}</p>
					{demo.safetyNote && (
						<p className="mt-1 text-[10px] text-amber-700 dark:text-amber-300">⚠ {demo.safetyNote}</p>
					)}
				</li>
			))}
		</ul>
	);
}
