"use client";
import type { CSSProperties } from "react";
import { Card } from "@/components/ui/card";
import { ScreenplayMarkdown } from "./markdown-renderer";

interface Props {
	markdown: string;
}

export function ScreenplayViewer({ markdown }: Props) {
	const paperTokens = {
		"--foreground": "#172033",
		"--muted-foreground": "#667085",
		"--border": "#d8dee8",
		"--card": "#f4f7fa",
		"--muted": "#e8edf3",
		"--background": "#ffffff",
	} as CSSProperties;
	return (
		<Card className="overflow-hidden border-border bg-card shadow-sm" style={paperTokens}>
			<div className="px-5 py-7 sm:px-7 lg:px-9 lg:py-9">
				<ScreenplayMarkdown markdown={markdown} />
			</div>
		</Card>
	);
}
