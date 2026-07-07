"use client";
import Link from "next/link";
import {
	FileText,
	Loader2,
	CheckCircle,
	AlertCircle,
	Clock,
	ArrowRight,
	Upload,
	Link2,
	Package,
	Link as LinkIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { localePath } from "@/lib/i18n/locale-path";

export interface Row {
	id: string;
	title: string;
	status: "pending" | "generating" | "ready" | "failed";
	updated_at: string;
	sourceKind: "upload" | "url" | "import" | "product" | null;
	category: string | null;
	hasProduct: boolean;
	versionCount: number;
}

// Icon + color classes only — the human-readable label comes from
// t(`status.${status}`) so `screenplay.status.*` is the single source of truth.
const STATUS_CONFIG: Record<Row["status"], { icon: typeof Clock; cls: string }> = {
	pending: { icon: Clock, cls: "bg-yellow-600/10 text-yellow-700 dark:text-yellow-300 border-yellow-200/80" },
	generating: { icon: Loader2, cls: "bg-blue-600/10 text-blue-700 dark:text-blue-300 border-blue-200/80" },
	ready: { icon: CheckCircle, cls: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-300 border-emerald-200/80" },
	failed: { icon: AlertCircle, cls: "bg-red-600/10 text-red-700 dark:text-red-300 border-red-200/80" },
};

// Source "how was it created" distinguisher — icon + per-source palette for
// both the avatar block and the small badge. `unknown` covers null source_kind
// (e.g. legacy rows or forward-of-migration rows).
type SourceKey = "upload" | "url" | "import" | "product" | "unknown";
const SOURCE_CONFIG: Record<SourceKey, { icon: typeof Clock; avatarCls: string; badgeCls: string }> = {
	upload: {
		icon: Upload,
		avatarCls: "bg-blue-600/10 ring-blue-200 text-blue-600",
		badgeCls: "bg-blue-600/10 text-blue-700 dark:text-blue-300 border-blue-200/80",
	},
	url: {
		icon: Link2,
		avatarCls: "bg-violet-600/10 ring-violet-200 text-violet-600",
		badgeCls: "bg-violet-600/10 text-violet-700 dark:text-violet-300 border-violet-200/80",
	},
	import: {
		icon: FileText,
		avatarCls: "bg-amber-600/10 ring-amber-200 text-amber-600",
		badgeCls: "bg-amber-600/10 text-amber-700 dark:text-amber-300 border-amber-200/80",
	},
	product: {
		icon: Package,
		avatarCls: "bg-emerald-600/10 ring-emerald-200 text-emerald-600",
		badgeCls: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-300 border-emerald-200/80",
	},
	unknown: {
		icon: FileText,
		avatarCls: "bg-slate-500/10 ring-slate-200 text-slate-500",
		badgeCls: "bg-slate-500/10 text-slate-600 dark:text-slate-300 border-slate-200/80",
	},
};

function formatStamp(iso: string): string {
	const d = new Date(iso);
	const pad = (n: number) => n.toString().padStart(2, "0");
	return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relativeFromNow(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	const min = Math.floor(ms / 60_000);
	if (min < 1) return "たった今";
	if (min < 60) return `${min}分前`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}時間前`;
	const day = Math.floor(hr / 24);
	if (day < 7) return `${day}日前`;
	return formatStamp(iso);
}

export function ScreenplayList({ rows, locale }: { rows: Row[]; locale: string }) {
	const t = useTranslations("screenplay");

	if (rows.length === 0) {
		return (
			<div className="rounded-2xl border border-border bg-card shadow-sm">
				<div className="py-16 flex flex-col items-center justify-center text-center px-6">
					<div className="w-16 h-16 bg-blue-600/10 rounded-2xl flex items-center justify-center mb-4 ring-1 ring-blue-200">
						<FileText size={26} className="text-blue-600" />
					</div>
					<p className="text-foreground font-medium">{t("list.empty.title")}</p>
					<p className="text-sm text-muted-foreground mt-1 max-w-sm">{t("list.empty.body")}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
			{/* Header strip */}
			<div className="hidden md:grid grid-cols-[1fr_auto_auto_auto] gap-4 items-center px-5 py-3 border-b border-border bg-muted/60">
				<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground">{t("list.col.title")}</div>
				<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground w-24 text-center">{t("list.col.status")}</div>
				<div className="text-[10px] font-semibold tracking-[0.16em] uppercase text-muted-foreground w-36 text-right">{t("list.col.updated")}</div>
				<div className="w-5" aria-hidden />
			</div>

			<ul className="divide-y divide-border">
				{rows.map((r) => {
					const cfg = STATUS_CONFIG[r.status];
					const Icon = cfg.icon;
					const srcKey: SourceKey = r.sourceKind ?? "unknown";
					const src = SOURCE_CONFIG[srcKey];
					const SrcIcon = src.icon;
					return (
						<li key={r.id}>
							<Link
								href={localePath(locale, `/screenplays/${r.id}`)}
								className="group grid grid-cols-[1fr_auto_auto_auto] md:grid-cols-[1fr_auto_auto_auto] gap-4 items-center px-5 py-3.5 hover:bg-blue-600/10 transition-colors"
							>
								<div className="min-w-0 flex items-center gap-3">
									{/* Avatar: category initial when known, otherwise the source icon —
									    colored by the source palette either way. */}
									<div className={`w-9 h-9 rounded-lg ring-1 flex items-center justify-center shrink-0 ${src.avatarCls}`}>
										{r.category ? (
											<span className="text-xs font-semibold uppercase">{r.category.trim().charAt(0)}</span>
										) : (
											<SrcIcon size={16} />
										)}
									</div>
									<div className="min-w-0">
										<div className="text-sm font-medium text-foreground truncate">
											{r.title || <span className="text-muted-foreground italic">（無題）</span>}
										</div>
										{/* Meta line: source badge · category chip · revisions · product link.
										    Wraps; every segment is conditional so nothing dangles when absent. */}
										<div className="flex items-center gap-1.5 mt-1 flex-wrap">
											<span
												className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${src.badgeCls}`}
											>
												<SrcIcon size={9} />
												{t(`source.${srcKey}`)}
											</span>
											{r.category && (
												<span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border max-w-[10rem] truncate">
													{r.category}
												</span>
											)}
											{r.versionCount > 0 && (
												<span className="text-[10px] text-muted-foreground tabular-nums">
													{t("list.revisions", { count: r.versionCount })}
												</span>
											)}
											{r.hasProduct && (
												<span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
													<LinkIcon size={9} />
													<Package size={9} />
												</span>
											)}
											<span className="text-[11px] text-muted-foreground font-mono md:hidden">{relativeFromNow(r.updated_at)}</span>
										</div>
									</div>
								</div>

								<span
									className={`hidden md:inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border ${cfg.cls} w-24 justify-center`}
								>
									<Icon size={11} className={r.status === "generating" ? "animate-spin" : ""} />
									{t(`status.${r.status}`)}
								</span>

								<span className="hidden md:block text-xs text-muted-foreground tabular-nums w-36 text-right">
									<span className="text-muted-foreground">{relativeFromNow(r.updated_at)}</span>
								</span>

								<ArrowRight
									size={14}
									className="text-muted-foreground group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all shrink-0"
								/>
							</Link>
						</li>
					);
				})}
			</ul>

			<div className="px-5 py-2.5 border-t border-border bg-muted/40 text-[11px] text-muted-foreground tabular-nums">
				{t("list.count", { count: rows.length })}
			</div>
		</div>
	);
}
