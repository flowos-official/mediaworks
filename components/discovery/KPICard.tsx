"use client";
interface Props {
	label: string;
	value: string | number;
	subtitle?: string;
	accent?: "green" | "red" | "blue" | "gray";
}

const ACCENT = {
	green: "bg-green-600/10 border-green-200 dark:border-green-900/40 text-green-700 dark:text-green-300",
	red: "bg-red-600/10 border-red-200 dark:border-red-900/40 text-red-700 dark:text-red-300",
	blue: "bg-blue-600/10 border-blue-200 dark:border-blue-900/40 text-blue-700 dark:text-blue-300",
	gray: "bg-muted border-border text-foreground",
};

export function KPICard({ label, value, subtitle, accent = "gray" }: Props) {
	return (
		<div className={`rounded-lg border p-4 ${ACCENT[accent]}`}>
			<div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{label}</div>
			<div className="text-2xl font-bold mt-1">{value}</div>
			{subtitle && <div className="text-[10px] opacity-60 mt-1">{subtitle}</div>}
		</div>
	);
}
