"use client";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

interface TrendItem {
	week: string;
	home: number;
	live: number;
}

export function ExplorationTrendChart({ data }: { data: TrendItem[] }) {
	return (
		<ResponsiveContainer width="100%" height={280}>
			<LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 10 }}>
				<XAxis dataKey="week" tick={{ fontSize: 9 }} tickFormatter={(w) => w.slice(5)} />
				<YAxis domain={[0, 1]} tickFormatter={(v) => `${Math.round(v * 100)}%`} tick={{ fontSize: 10 }} />
				<Tooltip formatter={(v) => typeof v === "number" ? `${Math.round(v * 100)}%` : v} contentStyle={{ fontSize: 11, borderRadius: 8 }} />
				<Legend wrapperStyle={{ fontSize: 10 }} />
				<Line type="monotone" dataKey="home" stroke="#3b82f6" strokeWidth={2} dot={{ r: 3 }} />
				<Line type="monotone" dataKey="live" stroke="#8b5cf6" strokeWidth={2} dot={{ r: 3 }} />
			</LineChart>
		</ResponsiveContainer>
	);
}
