"use client";

import { ExternalLink } from "lucide-react";
import { CHANNEL_BADGE, channelDisplayName } from "@/lib/broadcasts/channel-style";

export interface OARow {
	id: string;
	channel: string;
	air_date: string;
	day_of_week: string | null;
	product_name: string;
	price_text: string | null;
	price_jpy: number | null;
	price_is_tax_incl: boolean | null;
	source_url: string | null;
	category: string | null;
}

function formatPrice(row: OARow): string {
	if (row.price_jpy == null) return row.price_text ?? "—";
	const fmt = `¥${row.price_jpy.toLocaleString("ja-JP")}`;
	if (row.price_is_tax_incl === false) return `${fmt}（税抜）`;
	return fmt;
}

export default function OABroadcastListItem({ row }: { row: OARow }) {
	const badge =
		CHANNEL_BADGE[row.channel as keyof typeof CHANNEL_BADGE] ??
		"bg-gray-100 text-gray-700 border-gray-200";
	return (
		<div className="flex items-start gap-3 py-2 px-3 border-b border-gray-100 last:border-b-0 hover:bg-gray-50/50">
			<span
				className={`shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${badge}`}
			>
				{channelDisplayName(row.channel)}
			</span>
			<div className="flex-1 min-w-0">
				<div className="text-sm text-gray-900 truncate">{row.product_name}</div>
				{row.category && (
					<div className="text-[10px] text-gray-500 mt-0.5">{row.category}</div>
				)}
			</div>
			<div className="shrink-0 text-right text-xs text-gray-700 font-mono whitespace-nowrap">
				{formatPrice(row)}
			</div>
			{row.source_url && (
				<a
					href={row.source_url}
					target="_blank"
					rel="noopener noreferrer"
					className="shrink-0 text-gray-400 hover:text-gray-700"
					aria-label="external link"
				>
					<ExternalLink size={14} />
				</a>
			)}
		</div>
	);
}
