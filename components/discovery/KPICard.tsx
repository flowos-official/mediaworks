"use client";
interface Props {
	label: string;
	value: string | number;
	subtitle?: string;
	accent?: "green" | "red" | "blue" | "gray";
}

const ACCENT = {
	green: "border-emerald-500/20 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300",
	red: "border-red-500/20 bg-red-500/8 text-red-700 dark:text-red-300",
	blue: "border-primary/20 bg-primary/8 text-primary",
	gray: "border-border bg-card text-foreground",
};

export function KPICard({ label, value, subtitle, accent = "gray" }: Props) {
	return (
		<div className={`rounded-xl border p-4 shadow-sm ${ACCENT[accent]}`}>
			<div className="font-mono text-[9px] font-semibold uppercase tracking-[0.1em] opacity-70">{label}</div>
			<div className="mt-1 font-mono text-2xl font-semibold tracking-[-0.04em] tabular-nums">{value}</div>
			{subtitle && <div className="mt-1 text-[10px] opacity-60">{subtitle}</div>}
		</div>
	);
}
