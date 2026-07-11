"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import {
	FileText,
	Clock,
	CheckCircle,
	Loader2,
	AlertCircle,
	ArrowRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { Product } from "@/lib/supabase";
import { localePath } from "@/lib/i18n/locale-path";
import { explainErrorReason } from "@/lib/research/error-reason-explain";

interface ProductCardProps {
	product: Product;
}

const statusConfig = {
	pending: {
		icon: Clock,
		color: "bg-yellow-600/15 text-yellow-700 dark:text-yellow-300",
		label: "pending",
	},
	analyzing: {
		icon: Loader2,
		color: "bg-blue-600/15 text-blue-700 dark:text-blue-300",
		label: "analyzing",
	},
	completed: {
		icon: CheckCircle,
		color: "bg-green-600/15 text-green-700 dark:text-green-300",
		label: "completed",
	},
	failed: {
		icon: AlertCircle,
		color: "bg-red-600/15 text-red-700 dark:text-red-300",
		label: "failed",
	},
};

function elapsedMinutes(createdAt: string): number {
	return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000));
}

export default function ProductCard({ product }: ProductCardProps) {
	const locale = useLocale();
	const t = useTranslations("home");
	const config =
		statusConfig[product.status as keyof typeof statusConfig] ||
		statusConfig.pending;
	const Icon = config.icon;

	const [elapsed, setElapsed] = useState(() => elapsedMinutes(product.created_at));
	useEffect(() => {
		if (product.status !== "analyzing" && product.status !== "pending") return;
		const id = setInterval(() => setElapsed(elapsedMinutes(product.created_at)), 30000);
		return () => clearInterval(id);
	}, [product.status, product.created_at]);

	const isStale = elapsed >= 5 && elapsed < 12;
	const stuckHinted = elapsed >= 12;

	return (
		<Card className="group transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md">
			<CardContent className="p-4">
				<div className="flex items-start justify-between gap-3">
					<div className="flex items-start gap-3 flex-1 min-w-0">
						<div className="flex size-9 flex-shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/10">
							<FileText size={16} className="text-primary" />
						</div>
						<div className="flex-1 min-w-0">
							<h3 className="truncate text-sm font-semibold text-foreground">
								{product.name}
							</h3>
							{product.description && (
								<p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
									{product.description}
								</p>
							)}
							<p className="mt-2 font-mono text-[10px] text-muted-foreground">
								{new Date(product.created_at).toLocaleDateString()}
							</p>
						</div>
					</div>

					<div className="flex items-center gap-2 flex-shrink-0">
						<span
							className={`flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[10px] font-semibold ${config.color}`}
						>
							<Icon
								size={12}
								className={
									product.status === "analyzing" ? "animate-spin" : ""
								}
							/>
							{t(`status.${config.label}`)}
						</span>
					</div>
				</div>

				{/* Analyzing state — progress bar + elapsed message */}
				{product.status === "analyzing" && (
					<div className="mt-3 border-t border-border pt-3">
						<div className="h-1.5 bg-muted rounded-full overflow-hidden">
							<div className={`h-full rounded-full animate-pulse w-2/3 ${stuckHinted ? "bg-amber-500" : isStale ? "bg-amber-400" : "bg-blue-500"}`} />
						</div>
						<p className={`text-xs mt-2 text-center ${isStale ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}>
							{elapsed < 1
								? t("analyzingDefault")
								: t("analyzingWithElapsed", { minutes: elapsed })}
						</p>
						{isStale && (
							<p className="text-[10px] text-muted-foreground text-center mt-1">
								{t("analyzingWarning")}
							</p>
						)}
						{stuckHinted && (
							<p className="text-[10px] text-amber-700 dark:text-amber-300 text-center mt-1">
								{t("analyzingStuck")}
							</p>
						)}
					</div>
				)}

				{product.status === "failed" && (
					<div className="mt-3 border-t border-border pt-3">
						<p className="text-xs text-red-700 dark:text-red-300">
							{explainErrorReason(product.error_reason, locale === "ko" ? "ko" : "ja")}
						</p>
						<Link
							href={localePath(locale, "/")}
							className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
						>
							{t("reuploadLink")}
							<ArrowRight size={12} />
						</Link>
					</div>
				)}

				{product.status === "completed" && (
					<div className="mt-3 border-t border-border pt-3">
						<Link
							href={localePath(locale, `/products/${product.id}`)}
							className="flex min-h-9 w-full items-center justify-between gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition hover:bg-primary/88"
						>
							{t("viewReport")}
							<ArrowRight size={14} />
						</Link>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
