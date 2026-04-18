"use client";
interface Props {
	label: string;
	value: string | number;
	subtitle?: string;
	accent?: "green" | "red" | "blue" | "gray";
}

const ACCENT = {
	green: "bg-green-50 border-green-200 text-green-700",
	red: "bg-red-50 border-red-200 text-red-700",
	blue: "bg-blue-50 border-blue-200 text-blue-700",
	gray: "bg-gray-50 border-gray-200 text-gray-700",
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
