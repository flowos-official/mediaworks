"use client";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, type PieLabelRenderProps } from "recharts";

interface ReasonItem {
	reason: string;
	count: number;
}

const COLORS = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#06b6d4", "#6b7280"];

export function RejectionReasonChart({ data }: { data: ReasonItem[] }) {
	const buckets = new Map<string, number>();
	for (const d of data) {
		const key = d.reason.startsWith("その他") ? "その他" : d.reason;
		buckets.set(key, (buckets.get(key) ?? 0) + d.count);
	}
	const grouped = [...buckets.entries()].map(([reason, count]) => ({ reason, count }));

	return (
		<ResponsiveContainer width="100%" height={280}>
			<PieChart>
				<Pie
					data={grouped}
					dataKey="count"
					nameKey="reason"
					cx="50%"
					cy="50%"
					innerRadius={50}
					outerRadius={90}
					label={(e: PieLabelRenderProps) => {
						const entry = grouped[e.index as number];
						return entry ? `${entry.reason}: ${entry.count}` : "";
					}}
					labelLine={false}
				>
					{grouped.map((_, i) => (
						<Cell key={i} fill={COLORS[i % COLORS.length]} />
					))}
				</Pie>
				<Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} />
			</PieChart>
		</ResponsiveContainer>
	);
}
