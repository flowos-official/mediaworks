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
		<Card className="hover:shadow-md transition-shadow duration-200 border border-border">
			<CardContent className="p-5">
				<div className="flex items-start justify-between gap-3">
					<div className="flex items-start gap-3 flex-1 min-w-0">
						<div className="w-10 h-10 bg-blue-600/10 rounded-lg flex items-center justify-center flex-shrink-0">
							<FileText size={20} className="text-blue-600" />
						</div>
						<div className="flex-1 min-w-0">
							<h3 className="font-semibold text-foreground truncate">
								{product.name}
							</h3>
							{product.description && (
								<p className="text-sm text-muted-foreground mt-1 line-clamp-2">
									{product.description}
								</p>
							)}
							<p className="text-xs text-muted-foreground mt-1">
								{new Date(product.created_at).toLocaleDateString()}
							</p>
						</div>
					</div>

					<div className="flex items-center gap-2 flex-shrink-0">
						<span
							className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full ${config.color}`}
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
					<div className="mt-4 pt-4 border-t border-border">
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
					<div className="mt-4 pt-4 border-t border-border">
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
					<div className="mt-4 pt-4 border-t border-border">
						<Link
							href={localePath(locale, `/products/${product.id}`)}
							className="flex items-center justify-center gap-2 w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium py-2 px-4 rounded-lg transition-colors"
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
