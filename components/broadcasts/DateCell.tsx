"use client";

import type { KeyboardEvent } from "react";

import {
	ALL_CHANNELS,
	CHANNEL_BADGE,
	CHANNEL_DOT,
	CHANNEL_SHORT,
	channelDisplayName,
	type BroadcastChannelSlug,
} from "@/lib/broadcasts/channel-style";

interface Props {
	iso: string;
	dayLabel: number;
	isCurrentMonth: boolean;
	isToday: boolean;
	isSelected: boolean;
	view: "month" | "week";
	channelCounts: Record<string, number>;
	onClick: (iso: string) => void;
	onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

const DATE_LABEL_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
	year: "numeric",
	month: "long",
	day: "numeric",
	weekday: "long",
	timeZone: "Asia/Tokyo",
});

export default function DateCell({
	iso,
	dayLabel,
	isCurrentMonth,
	isToday,
	isSelected,
	view,
	channelCounts,
	onClick,
	onKeyDown,
}: Props) {
	const base = `relative min-w-0 overflow-hidden rounded-lg border p-1 text-left transition-colors sm:rounded-xl sm:p-2 ${view === "week" ? "min-h-16 sm:min-h-24" : "aspect-square sm:aspect-auto sm:min-h-[4.75rem]"}`;
	const muted = !isCurrentMonth;
	const todayRing = isToday && !isSelected;

	const cls = [
		base,
		isSelected
			? "bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
			: muted
				? "bg-muted text-muted-foreground border-border hover:bg-accent"
				: "bg-card text-foreground border-border hover:bg-muted",
		todayRing ? "ring-2 ring-blue-400" : "",
	].join(" ");

	const activeChannels = ALL_CHANNELS.filter(
		(c) => (channelCounts[c.slug] ?? 0) > 0,
	);
	const total = activeChannels.reduce((sum, channel) => sum + (channelCounts[channel.slug] ?? 0), 0);
	const visibleChannels = activeChannels.slice(0, view === "week" ? 3 : 2);
	const hiddenChannelCount = activeChannels.length - visibleChannels.length;
	const dateLabel = DATE_LABEL_FORMATTER.format(new Date(`${iso}T00:00:00+09:00`));
	const visibleSummary = total > 0
		? `${dayLabel} ${total} ${visibleChannels.map(({ slug }) => `${CHANNEL_SHORT[slug]} ${channelCounts[slug] ?? 0}`).join(" ")}${hiddenChannelCount > 0 ? ` +${hiddenChannelCount}局` : ""}`
		: `${dayLabel} —`;
	const ariaLabel = `${visibleSummary}、${dateLabel}、${total}件${isToday ? "、今日" : ""}`;

	return (
		<button
			type="button"
			data-calendar-date={iso}
			onClick={() => onClick(iso)}
			onKeyDown={onKeyDown}
			className={cls}
			aria-pressed={isSelected}
			title={ariaLabel}
		>
			<span className="sr-only">{ariaLabel}</span>
			<div aria-hidden="true">
			<div className="flex items-start justify-between gap-1">
				<span className="text-sm font-semibold leading-tight">{dayLabel}</span>
				{total > 0 && (
					<span className={`rounded-md px-1 py-0.5 font-mono text-[9px] font-semibold tabular-nums ${isSelected ? "bg-blue-950/60 text-white" : "bg-primary/10 text-primary"}`}>
						{total}
					</span>
				)}
			</div>
			{activeChannels.length > 0 ? (
				<>
					<div className="mt-1.5 flex items-center gap-[3px] sm:hidden">
						{activeChannels.slice(0, 4).map(({ slug }) => (
							<span key={slug} className={`size-1.5 rounded-full ${CHANNEL_DOT[slug]}`} />
						))}
					</div>
					<div className="mt-1.5 hidden min-w-0 flex-col gap-[3px] sm:flex">
					{visibleChannels.map(({ slug, name }) => {
						const n = channelCounts[slug] ?? 0;
						const short =
							CHANNEL_SHORT[slug as BroadcastChannelSlug] ?? slug[0];
						const palette =
							CHANNEL_BADGE[slug as BroadcastChannelSlug] ??
							"bg-muted text-muted-foreground border-border";
						return (
							<span
								key={slug}
								title={`${channelDisplayName(slug)}: ${n}件`}
								aria-label={`${name} ${n}件`}
								className={`inline-flex max-w-full items-center justify-between gap-1 overflow-hidden rounded-[4px] border px-1 text-[9px] font-semibold leading-[15px] tabular-nums ${palette} ${
									isSelected ? "!border-white/60 !bg-blue-950/60 !text-white ring-1 ring-white/60" : ""
								}`}
							>
								<span className="truncate">{short}</span>
								<span className={isSelected ? "text-white" : "opacity-80"}>{n}</span>
							</span>
						);
					})}
					{hiddenChannelCount > 0 && (
						<span className={`pl-0.5 text-[9px] font-medium ${isSelected ? "text-white" : "text-muted-foreground"}`}>
							+{hiddenChannelCount}局
						</span>
					)}
					</div>
				</>
			) : (
				<div
					className={`text-[10px] leading-tight mt-1 ${
						isSelected ? "text-blue-200" : "text-muted-foreground/50"
					}`}
				>
					—
				</div>
			)}
			</div>
		</button>
	);
}
