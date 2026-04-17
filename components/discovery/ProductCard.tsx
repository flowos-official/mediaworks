import { useTranslations } from "next-intl";

export type DiscoveredProductRow = {
	id: string;
	name: string;
	thumbnail_url: string | null;
	product_url: string;
	price_jpy: number | null;
	category: string | null;
	seller_name: string | null;
	review_count: number | null;
	review_avg: number | null;
	tv_fit_score: number | null;
	tv_fit_reason: string | null;
	broadcast_tag: "broadcast_confirmed" | "broadcast_likely" | "unknown" | null;
	track: "tv_proven" | "exploration";
	stock_status: string | null;
};

export function ProductCard({ product }: { product: DiscoveredProductRow }) {
	const t = useTranslations("discovery");
	const score = product.tv_fit_score ?? 0;

	const scoreColor =
		score >= 80
			? "bg-green-100 text-green-800 border-green-200"
			: score >= 60
			? "bg-yellow-100 text-yellow-800 border-yellow-200"
			: "bg-gray-100 text-gray-600 border-gray-200";

	const trackLabel =
		product.track === "tv_proven" ? t("trackTvProven") : t("trackExploration");

	const broadcastBadge =
		product.broadcast_tag === "broadcast_confirmed"
			? { label: t("broadcastConfirmed"), color: "bg-red-50 text-red-700" }
			: product.broadcast_tag === "broadcast_likely"
			? { label: t("broadcastLikely"), color: "bg-orange-50 text-orange-700" }
			: null;

	return (
		<article className="flex gap-4 p-4 bg-white border border-gray-200 rounded-lg hover:shadow-sm transition-shadow">
			<div className="flex-shrink-0 w-28 h-28 bg-gray-100 rounded overflow-hidden">
				{product.thumbnail_url ? (
					<img
						src={product.thumbnail_url}
						alt={product.name}
						className="w-full h-full object-cover"
					/>
				) : (
					<div className="w-full h-full flex items-center justify-center text-gray-400 text-xs">
						no image
					</div>
				)}
			</div>

			<div className="flex-1 min-w-0">
				<div className="flex items-start justify-between gap-2 mb-1">
					<h3 className="text-sm font-medium text-gray-900 line-clamp-2 flex-1">
						{product.name}
					</h3>
					<span
						className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-semibold ${scoreColor}`}
					>
						{score}
					</span>
				</div>

				<div className="flex flex-wrap items-center gap-2 text-xs text-gray-600 mb-1">
					<span className="font-medium text-gray-900">
						{product.price_jpy ? `¥${product.price_jpy.toLocaleString()}` : "¥?"}
					</span>
					{product.review_avg !== null && (
						<span>
							★{product.review_avg} ({product.review_count ?? 0})
						</span>
					)}
					{product.seller_name && <span className="truncate max-w-[200px]">{product.seller_name}</span>}
				</div>

				<div className="flex flex-wrap items-center gap-1 mb-2">
					<span className="inline-block px-2 py-0.5 rounded bg-gray-100 text-gray-700 text-[10px]">
						{trackLabel}
					</span>
					{broadcastBadge && (
						<span className={`inline-block px-2 py-0.5 rounded text-[10px] ${broadcastBadge.color}`}>
							{broadcastBadge.label}
						</span>
					)}
				</div>

				{product.tv_fit_reason && (
					<p className="text-xs text-gray-600 line-clamp-2 mb-2">{product.tv_fit_reason}</p>
				)}

				<a
					href={product.product_url}
					target="_blank"
					rel="noopener noreferrer"
					className="text-xs text-blue-600 hover:underline"
				>
					{t("goLive")} →
				</a>
			</div>
		</article>
	);
}
