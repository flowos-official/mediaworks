"use client";

import {
	ALL_CHANNELS,
	CHANNEL_BADGE,
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
	channelCounts: Record<string, number>;
	onClick: (iso: string) => void;
}

export default function DateCell({
	iso,
	dayLabel,
	isCurrentMonth,
	isToday,
	isSelected,
	channelCounts,
	onClick,
}: Props) {
	const base = "aspect-square rounded-lg p-1.5 text-left transition-colors border";
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

	return (
		<button type="button" onClick={() => onClick(iso)} className={cls}>
			<div className="text-sm font-semibold leading-tight">{dayLabel}</div>
			{activeChannels.length > 0 ? (
				<div className="mt-1 flex flex-wrap gap-[2px]">
					{activeChannels.map(({ slug, name }) => {
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
								className={`inline-flex items-center gap-[1px] px-[3px] rounded-[3px] text-[9px] font-semibold leading-[14px] tabular-nums border ${palette} ${
									isSelected ? "ring-1 ring-white/60" : ""
								}`}
							>
								<span>{short}</span>
								<span className="opacity-80">{n}</span>
							</span>
						);
					})}
				</div>
			) : (
				<div
					className={`text-[10px] leading-tight mt-1 ${
						isSelected ? "text-blue-200" : "text-muted-foreground/50"
					}`}
				>
					—
				</div>
			)}
		</button>
	);
}
