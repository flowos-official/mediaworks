"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";

interface Item {
	category: string;
	sourced: number;
	shown: number;
	rate: number;
}

export function CategorySourcingChart({ data }: { data: Item[] }) {
	const sorted = [...data].sort((a, b) => b.rate - a.rate).slice(0, 10);
	return (
		<ResponsiveContainer width="100%" height={280}>
			<BarChart data={sorted} layout="vertical" margin={{ top: 10, right: 20, left: 60, bottom: 10 }}>
				<XAxis type="number" domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 10 }} />
				<YAxis type="category" dataKey="category" width={80} tick={{ fontSize: 10 }} />
				<Tooltip formatter={(v) => typeof v === "number" ? `${Math.round(v * 100)}%` : v} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
				<Bar dataKey="rate" fill="#3b82f6" radius={[0, 4, 4, 0]} />
			</BarChart>
		</ResponsiveContainer>
	);
}
