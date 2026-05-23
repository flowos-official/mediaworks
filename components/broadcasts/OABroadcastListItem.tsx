"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { CHANNEL_BADGE, channelDisplayName } from "@/lib/broadcasts/channel-style";
import { CompetitorFitPanel } from "./CompetitorFitPanel";

export interface OARow {
	id: string;
	channel: string;
	air_date: string;
	day_of_week: string | null;
	start_time: string | null;
	product_name: string;
	price_text: string | null;
	price_jpy: number | null;
	price_is_tax_incl: boolean | null;
	source_url: string | null;
	category: string | null;
	image_url: string | null;
}

function formatPrice(row: OARow): string {
	if (row.price_jpy == null) return row.price_text ?? "—";
	const fmt = `¥${row.price_jpy.toLocaleString("ja-JP")}`;
	if (row.price_is_tax_incl === false) return `${fmt}（税抜）`;
	return fmt;
}

function formatTime(t: string): string {
	return t.slice(0, 5);
}

export default function OABroadcastListItem({ row }: { row: OARow }) {
	const [open, setOpen] = useState(false);
	const badge =
		CHANNEL_BADGE[row.channel as keyof typeof CHANNEL_BADGE] ??
		"bg-muted text-foreground border-border";
	return (
		<div className="border-b border-border last:border-b-0">
			<div className="flex items-start gap-3 py-2 px-3 hover:bg-muted/50">
				<span className="shrink-0 font-mono text-[11px] text-foreground w-10 text-right tabular-nums pt-0.5">
					{row.start_time ? formatTime(row.start_time) : "—"}
				</span>
				{row.image_url ? (
					<img
						src={row.image_url}
						alt=""
						className="shrink-0 w-12 h-12 object-cover rounded border border-border"
						loading="lazy"
						onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
					/>
				) : (
					<div
						className="shrink-0 w-12 h-12 rounded bg-muted border border-border"
						aria-hidden="true"
					/>
				)}
				<span
					className={`shrink-0 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${badge}`}
				>
					{channelDisplayName(row.channel)}
				</span>
				<div className="flex-1 min-w-0">
					<div className="text-sm text-foreground truncate">{row.product_name}</div>
					{row.category && (
						<div className="text-[10px] text-muted-foreground mt-0.5 truncate">{row.category}</div>
					)}
				</div>
				<div
					className="shrink-0 text-right text-xs text-foreground font-mono truncate max-w-[7rem]"
					title={formatPrice(row)}
				>
					{formatPrice(row)}
				</div>
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					className={`shrink-0 text-muted-foreground hover:text-indigo-600 transition-transform ${open ? "rotate-180 text-indigo-600" : ""}`}
					aria-label="toggle analysis"
					aria-expanded={open}
				>
					<ChevronDown size={14} />
				</button>
				{row.source_url && (
					<a
						href={row.source_url}
						target="_blank"
						rel="noopener noreferrer"
						className="shrink-0 text-muted-foreground hover:text-foreground"
						aria-label="external link"
					>
						<ExternalLink size={14} />
					</a>
				)}
			</div>
			{open && (
				<div className="px-3 pb-3 flex flex-col gap-3">
					<div className="flex gap-3 items-start">
						{row.image_url ? (
							<img
								src={row.image_url}
								alt=""
								className="shrink-0 w-28 h-28 object-cover rounded border border-border bg-muted"
								loading="lazy"
								onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
							/>
						) : (
							<div
								className="shrink-0 w-28 h-28 rounded bg-muted border border-border"
								aria-hidden="true"
							/>
						)}
						<div className="flex-1 min-w-0 space-y-2">
							<div className="text-sm font-medium text-foreground leading-snug break-words">
								{row.product_name}
							</div>
							<dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1 text-[11px]">
								<dt className="text-muted-foreground">放送日</dt>
								<dd className="text-foreground">
									{row.air_date}
									{row.day_of_week ? `（${row.day_of_week}）` : ""}
									{row.start_time ? ` ${formatTime(row.start_time)}` : ""}
								</dd>
								<dt className="text-muted-foreground">チャンネル</dt>
								<dd className="text-foreground">{channelDisplayName(row.channel)}</dd>
								{row.category && (
									<>
										<dt className="text-muted-foreground">カテゴリ</dt>
										<dd className="text-foreground break-words">{row.category}</dd>
									</>
								)}
								<dt className="text-muted-foreground">価格</dt>
								<dd className="text-foreground break-words">
									{formatPrice(row)}
									{row.price_jpy != null && row.price_text && row.price_text !== formatPrice(row) && (
										<span className="text-muted-foreground"> （{row.price_text}）</span>
									)}
								</dd>
							</dl>
							{row.source_url && (
								<a
									href={row.source_url}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
								>
									<ExternalLink size={11} />
									元のページを開く
								</a>
							)}
						</div>
					</div>
					<CompetitorFitPanel
						slot={{
							channel: row.channel,
							productName: row.product_name,
							category: row.category,
							priceText: row.price_text,
							airDate: row.air_date,
							startTime: row.start_time,
							sourceUrl: row.source_url,
						}}
					/>
				</div>
			)}
		</div>
	);
}
