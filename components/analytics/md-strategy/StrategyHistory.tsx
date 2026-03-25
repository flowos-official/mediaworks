'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { History, Eye, Trash2, Loader2 } from 'lucide-react';

type StrategySummary = {
	id: string;
	user_goal: string | null;
	category: string | null;
	target_market: string | null;
	price_range: string | null;
	created_at: string;
};

interface Props {
	onView: (id: string) => void;
	refreshKey: number; // increment to trigger refetch
}

export default function StrategyHistory({ onView, refreshKey }: Props) {
	const [strategies, setStrategies] = useState<StrategySummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [deleting, setDeleting] = useState<string | null>(null);

	const fetchList = useCallback(async () => {
		setLoading(true);
		try {
			const res = await fetch('/api/analytics/md-strategy');
			const data = await res.json();
			setStrategies(data.strategies ?? []);
		} catch {
			// silent
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		fetchList();
	}, [fetchList, refreshKey]);

	const handleDelete = async (id: string) => {
		if (!confirm('この戦略を削除しますか？')) return;
		setDeleting(id);
		try {
			const res = await fetch(`/api/analytics/md-strategy/${id}`, { method: 'DELETE' });
			if (res.ok) {
				setStrategies((prev) => prev.filter((s) => s.id !== id));
			}
		} catch {
			// silent
		} finally {
			setDeleting(null);
		}
	};

	if (loading) {
		return (
			<div className="flex items-center gap-2 py-4 text-sm text-gray-400">
				<Loader2 size={14} className="animate-spin" />
				履歴を読み込み中...
			</div>
		);
	}

	if (strategies.length === 0) return null;

	return (
		<Card className="border-gray-200">
			<CardHeader className="pb-2">
				<CardTitle className="text-sm font-semibold flex items-center gap-1.5 text-gray-700">
					<History size={14} /> 過去の戦略分析
				</CardTitle>
			</CardHeader>
			<CardContent>
				<div className="space-y-2">
					{strategies.map((s) => (
						<div key={s.id} className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg border border-gray-100 hover:border-gray-200 transition-colors">
							<div className="flex-1 min-w-0">
								<div className="flex items-center gap-2 mb-0.5">
									<span className="text-xs font-mono text-gray-500">
										{new Date(s.created_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
									</span>
									{s.category && s.category !== '指定なし' && (
										<span className="text-[9px] px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded">{s.category}</span>
									)}
									{s.target_market && s.target_market !== '指定なし' && (
										<span className="text-[9px] px-1.5 py-0.5 bg-purple-50 text-purple-700 rounded">{s.target_market}</span>
									)}
								</div>
								{s.user_goal && (
									<p className="text-xs text-gray-600 truncate">{s.user_goal}</p>
								)}
								{!s.user_goal && (
									<p className="text-xs text-gray-400 italic">目標指定なし</p>
								)}
							</div>
							<div className="flex items-center gap-1.5 shrink-0">
								<button
									type="button"
									onClick={() => onView(s.id)}
									className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
								>
									<Eye size={12} />
									表示
								</button>
								<button
									type="button"
									onClick={() => handleDelete(s.id)}
									disabled={deleting === s.id}
									className="flex items-center gap-1 px-2 py-1.5 text-xs text-red-500 hover:bg-red-50 rounded-lg transition-colors disabled:opacity-50"
								>
									{deleting === s.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
								</button>
							</div>
						</div>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
