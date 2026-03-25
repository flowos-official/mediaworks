'use client';

import { ExternalLink } from 'lucide-react';

interface Source {
	index: number;
	title: string;
	url: string;
}

interface Props {
	sources?: Source[];
}

export default function SourcesCited({ sources }: Props) {
	if (!sources || sources.length === 0) return null;

	return (
		<div className="border-t border-gray-100 pt-3 mt-4">
			<span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">出典</span>
			<div className="mt-1 space-y-0.5">
				{sources.map((s) => (
					<a
						key={s.index}
						href={s.url}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center gap-1.5 text-[10px] text-blue-500 hover:text-blue-700 hover:underline truncate"
					>
						<span className="text-gray-400 font-mono shrink-0">[{s.index}]</span>
						<ExternalLink size={9} className="shrink-0" />
						<span className="truncate">{s.title || s.url}</span>
					</a>
				))}
			</div>
		</div>
	);
}
