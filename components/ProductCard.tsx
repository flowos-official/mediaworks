"use client";

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

interface ProductCardProps {
	product: Product;
}

const statusConfig = {
	pending: {
		icon: Clock,
		color: "bg-yellow-100 text-yellow-700",
		label: "pending",
	},
	extracted: {
		icon: Loader2,
		color: "bg-blue-100 text-blue-700",
		label: "analyzing",
	},
	analyzing: {
		icon: Loader2,
		color: "bg-blue-100 text-blue-700",
		label: "analyzing",
	},
	completed: {
		icon: CheckCircle,
		color: "bg-green-100 text-green-700",
		label: "completed",
	},
	failed: {
		icon: AlertCircle,
		color: "bg-red-100 text-red-700",
		label: "failed",
	},
};

export default function ProductCard({ product }: ProductCardProps) {
	const locale = useLocale();
	const t = useTranslations("home");
	const config =
		statusConfig[product.status as keyof typeof statusConfig] ||
		statusConfig.pending;
	const Icon = config.icon;

	return (
		<Card className="hover:shadow-md transition-shadow duration-200 border border-gray-200">
			<CardContent className="p-5">
				<div className="flex items-start justify-between gap-3">
					<div className="flex items-start gap-3 flex-1 min-w-0">
						<div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
							<FileText size={20} className="text-blue-600" />
						</div>
						<div className="flex-1 min-w-0">
							<h3 className="font-semibold text-gray-900 truncate">
								{product.name}
							</h3>
							{product.description && (
								<p className="text-sm text-gray-500 mt-1 line-clamp-2">
									{product.description}
								</p>
							)}
							<p className="text-xs text-gray-400 mt-1">
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

				{/* Analyzing state — progress bar + message */}
				{(product.status === "analyzing" || product.status === "extracted") && (
					<div className="mt-4 pt-4 border-t border-gray-100">
						<div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
							<div className="h-full bg-blue-500 rounded-full animate-pulse w-2/3" />
						</div>
						<p className="text-xs text-gray-500 mt-2 text-center">
							AI 분석 중... 새로고침해도 계속됩니다
						</p>
					</div>
				)}

				{product.status === "completed" && (
					<div className="mt-4 pt-4 border-t border-gray-100">
						<Link
							href={`/${locale}/products/${product.id}`}
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
