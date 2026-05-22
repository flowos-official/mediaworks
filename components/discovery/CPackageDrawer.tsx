"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	Building2,
	DollarSign,
	Package,
	Tv,
	TrendingUp,
	ExternalLink,
	Copy,
	CheckCircle2,
	AlertCircle,
} from "lucide-react";
import type { CPackage, Confidence } from "@/lib/discovery/types";

function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
	const t = useTranslations("discovery");
	const colorMap = {
		high: "bg-green-600/15 text-green-800 border-green-200",
		medium: "bg-yellow-600/15 text-yellow-800 border-yellow-200",
		low: "bg-muted text-muted-foreground border-border",
	};
	const labelMap = {
		high: t("confidenceHigh"),
		medium: t("confidenceMedium"),
		low: t("confidenceLow"),
	};
	return (
		<span className={`text-[9px] px-1.5 py-0.5 rounded border ${colorMap[confidence]}`}>
			{labelMap[confidence]}
		</span>
	);
}

export function CPackageDrawer({ pkg }: { pkg: CPackage }) {
	const t = useTranslations("discovery");
	const [copied, setCopied] = useState(false);

	const m = pkg.manufacturer;
	const w = pkg.wholesale_estimate;
	const s = pkg.sns_trend;

	const snsLabel = {
		high: t("snsStrong"),
		medium: t("snsMedium"),
		low: t("snsWeak"),
		none: t("snsNone"),
	}[s.signal_strength];
	const snsColor = {
		high: "text-red-700 bg-red-600/10 border-red-200",
		medium: "text-orange-700 bg-orange-600/10 border-orange-200",
		low: "text-yellow-700 bg-yellow-600/10 border-yellow-200",
		none: "text-muted-foreground bg-muted border-border",
	}[s.signal_strength];

	async function copyScript() {
		try {
			await navigator.clipboard.writeText(pkg.tv_script_draft);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch {
			/* ignore */
		}
	}

	return (
		<div className="mt-3 pt-3 border-t border-border space-y-3">
			{pkg.partial && (
				<div className="flex items-center gap-1 text-[10px] text-amber-700 bg-amber-600/10 border border-amber-200 rounded px-2 py-1">
					<AlertCircle size={10} />
					{t("partialResult")}
				</div>
			)}

			{/* Manufacturer */}
			<div className="bg-blue-600/10 border border-blue-200 rounded p-2 space-y-1">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-1">
						<Building2 size={11} className="text-blue-600" />
						<span className="text-[10px] font-bold text-blue-700 uppercase tracking-wide">
							{t("manufacturer")}
						</span>
					</div>
					<ConfidenceBadge confidence={m.confidence} />
				</div>
				{m.name ? (
					<div className="text-[11px] text-foreground font-medium">{m.name}</div>
				) : (
					<div className="text-[11px] text-muted-foreground">{t("manufacturerUnknown")}</div>
				)}
				{m.official_site && (
					<a
						href={m.official_site}
						target="_blank"
						rel="noopener noreferrer"
						className="text-[10px] text-blue-600 hover:underline inline-flex items-center gap-0.5"
					>
						<ExternalLink size={9} />
						{t("officialSite")}
					</a>
				)}
				{m.address && (
					<div className="text-[10px] text-muted-foreground">
						<span className="font-semibold">{t("address")}:</span> {m.address}
					</div>
				)}
				{m.contact_hints.length > 0 && (
					<div className="text-[10px] text-muted-foreground">
						<span className="font-semibold">{t("contactHints")}:</span>{" "}
						{m.contact_hints.join(", ")}
					</div>
				)}
			</div>

			{/* Wholesale */}
			<div className="bg-green-600/10 border border-green-200 rounded p-2 space-y-1">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-1">
						<DollarSign size={11} className="text-green-600" />
						<span className="text-[10px] font-bold text-green-700 uppercase tracking-wide">
							{t("wholesaleEstimate")}
						</span>
					</div>
					<ConfidenceBadge confidence={w.confidence} />
				</div>
				{w.estimated_cost_jpy !== null ? (
					<>
						<div className="text-[11px] text-foreground">
							¥{w.retail_jpy.toLocaleString()} →{" "}
							<strong className="text-green-700">
								¥{w.estimated_cost_jpy.toLocaleString()}
							</strong>{" "}
							<span className="text-muted-foreground">
								({Math.round((w.estimated_margin_rate ?? 0) * 100)}%)
							</span>
						</div>
						<div className="text-[10px] text-muted-foreground">
							<span className="font-semibold">{t("wholesaleMethod")}:</span>{" "}
							{w.method === "blended"
								? t("wholesaleMethodBlended")
								: t("wholesaleMethodBaseline")}
							{w.sample_size > 0 && ` (n=${w.sample_size})`}
						</div>
					</>
				) : (
					<div className="text-[11px] text-muted-foreground">—</div>
				)}
			</div>

			{/* MOQ */}
			{pkg.moq_hint && (
				<div className="flex items-start gap-1.5 text-[11px] text-foreground">
					<Package size={11} className="text-muted-foreground mt-0.5 shrink-0" />
					<span>
						<span className="font-semibold">{t("moqHint")}:</span> {pkg.moq_hint}
					</span>
				</div>
			)}

			{/* TV Script */}
			<div className="bg-purple-600/10 border border-purple-200 rounded p-2 space-y-1">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-1">
						<Tv size={11} className="text-purple-600" />
						<span className="text-[10px] font-bold text-purple-700 uppercase tracking-wide">
							{t("tvScript")}
						</span>
					</div>
					<button
						type="button"
						onClick={copyScript}
						className="text-[10px] text-purple-600 hover:text-purple-800 inline-flex items-center gap-0.5"
					>
						{copied ? (
							<>
								<CheckCircle2 size={10} />
								{t("scriptCopied")}
							</>
						) : (
							<>
								<Copy size={10} />
								{t("copyScript")}
							</>
						)}
					</button>
				</div>
				<pre className="text-[10px] text-foreground whitespace-pre-wrap font-sans leading-relaxed">
					{pkg.tv_script_draft}
				</pre>
			</div>

			{/* SNS */}
			<div className={`flex items-center gap-1.5 text-[11px] border rounded px-2 py-1 ${snsColor}`}>
				<TrendingUp size={11} />
				<span className="font-semibold">{t("snsTrend")}:</span>
				<span>{snsLabel}</span>
				{s.sources.length > 0 && (
					<span className="text-[10px] opacity-70">({s.sources.join(", ")})</span>
				)}
			</div>
		</div>
	);
}
