"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { TvEvidence } from "@/lib/discovery/types";

interface Props {
	productId: string;
}

export default function TvEvidenceBadge({ productId }: Props) {
	const [ev, setEv] = useState<TvEvidence | null | "loading" | "error">("loading");

	useEffect(() => {
		let cancelled = false;
		fetch(`/api/discovery/${productId}/tv-evidence`)
			.then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
			.then((data: { tv_evidence: TvEvidence | null }) => {
				if (!cancelled) setEv(data.tv_evidence);
			})
			.catch(() => {
				if (!cancelled) setEv("error");
			});
		return () => {
			cancelled = true;
		};
	}, [productId]);

	if (ev === "loading" || ev === "error" || ev === null) return null;

	const channelSummary = Object.entries(ev.channel_breakdown)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 3)
		.map(([ch, n]) => `${ch.toUpperCase()} ${n}回`)
		.join(" · ");

	const priceText = ev.price_jpy
		? ` · 中央値 ¥${ev.price_jpy.median.toLocaleString()}`
		: "";

	return (
		<Badge variant="outline" className="text-xs font-normal" title={`実測放送データ (強度 ${(ev.evidence_strength * 100).toFixed(0)}%)`}>
			📺 {channelSummary} · 30日内 {ev.recent_30d_count}回{priceText}
		</Badge>
	);
}
