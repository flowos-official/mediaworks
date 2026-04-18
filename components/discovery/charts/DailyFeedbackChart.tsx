"use client";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

interface DailyItem {
	date: string;
	sourced: number;
	interested: number;
	rejected: number;
	duplicate: number;
}

export function DailyFeedbackChart({ data }: { data: DailyItem[] }) {
	return (
		<ResponsiveContainer width="100%" height={280}>
			<BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 10 }}>
				<XAxis dataKey="date" tick={{ fontSize: 9 }} tickFormatter={(d) => d.slice(5)} />
				<YAxis tick={{ fontSize: 10 }} />
				<Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} />
				<Legend wrapperStyle={{ fontSize: 10 }} />
				<Bar dataKey="sourced" stackId="a" fill="#22c55e" />
				<Bar dataKey="interested" stackId="a" fill="#f97316" />
				<Bar dataKey="rejected" stackId="a" fill="#ef4444" />
				<Bar dataKey="duplicate" stackId="a" fill="#9ca3af" />
			</BarChart>
		</ResponsiveContainer>
	);
}
