"use client";

/* eslint-disable @next/next/no-img-element -- Broadcast feeds provide arbitrary remote image hosts at runtime. */

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
			<div className="flex min-w-0 items-start gap-2 px-3 py-2 hover:bg-muted/50 sm:gap-3">
				{row.image_url ? (
					<img
						src={row.image_url}
						alt=""
						className="size-12 shrink-0 rounded border border-border object-cover"
						loading="lazy"
						onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
					/>
				) : (
					<div className="size-12 shrink-0 rounded border border-border bg-muted" aria-hidden="true" />
				)}
				<div className="flex-1 min-w-0">
					<div className="flex min-w-0 flex-wrap items-center gap-1.5">
						<span className="font-mono text-[11px] font-semibold tabular-nums text-foreground">
							{row.start_time ? formatTime(row.start_time) : "—"}
						</span>
						<span className={`inline-flex max-w-full items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${badge}`}>
							{channelDisplayName(row.channel)}
						</span>
					</div>
					<div className="mt-1 line-clamp-2 text-sm font-medium leading-snug text-foreground">{row.product_name}</div>
					<div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
						{row.category && <span className="truncate">{row.category}</span>}
						<span className="font-mono text-foreground">{formatPrice(row)}</span>
					</div>
				</div>
				<div className="flex shrink-0 flex-col gap-0.5 sm:flex-row">
					<button
						type="button"
						onClick={() => setOpen((v) => !v)}
						className={`flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-indigo-600 ${open ? "text-indigo-600" : ""}`}
						aria-label={open ? "分析を閉じる" : "分析を開く"}
						aria-expanded={open}
					>
						<ChevronDown size={14} className={`transition-transform ${open ? "rotate-180" : ""}`} />
					</button>
					{row.source_url && (
						<a href={row.source_url} target="_blank" rel="noopener noreferrer" className="flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="元ページを新しいタブで開く">
							<ExternalLink size={14} />
						</a>
					)}
				</div>
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
