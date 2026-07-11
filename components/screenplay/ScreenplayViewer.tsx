"use client";
import type { CSSProperties } from "react";
import { Card } from "@/components/ui/card";
import { ScreenplayMarkdown } from "./markdown-renderer";

interface Props {
	markdown: string;
	focusMode?: boolean;
	onTextSelection?: (selection: ScriptSelection) => void;
}

export interface ScriptSelection {
	text: string;
	line: number | null;
}

export function ScreenplayViewer({ markdown, focusMode = false, onTextSelection }: Props) {
	const paperTokens = {
		"--foreground": "#172033",
		"--muted-foreground": "#667085",
		"--border": "#d8dee8",
		"--card": "#f4f7fa",
		"--muted": "#e8edf3",
		"--background": "#ffffff",
	} as CSSProperties;

	function captureSelection() {
		if (!onTextSelection) return;
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed) return;
		const text = selection.toString().replace(/\s+/gu, " ").trim();
		if (text.length < 2) return;
		const anchor = selection.anchorNode;
		const element = anchor instanceof Element ? anchor : anchor?.parentElement;
		const block = element?.closest<HTMLElement>("[data-md-line]");
		const rawLine = block?.dataset.mdLine;
		const parsedLine = rawLine === undefined ? Number.NaN : Number(rawLine);
		onTextSelection({
			text: text.slice(0, 2000),
			line: Number.isFinite(parsedLine) ? parsedLine : null,
		});
	}

	return (
		<Card
			className={`overflow-hidden border-border bg-card ${focusMode ? "shadow-[0_24px_70px_rgba(15,23,42,0.12)]" : "shadow-sm"}`}
			style={paperTokens}
			onPointerUp={captureSelection}
			onKeyUp={captureSelection}
		>
			<div className={focusMode ? "px-6 py-9 sm:px-10 lg:px-16 lg:py-14" : "px-5 py-7 sm:px-7 lg:px-9 lg:py-9"}>
				<ScreenplayMarkdown markdown={markdown} />
			</div>
		</Card>
	);
}
