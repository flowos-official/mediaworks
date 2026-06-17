"use client";
import { Card } from "@/components/ui/card";
import { ScreenplayMarkdown } from "./markdown-renderer";

interface Props {
	markdown: string;
}

export function ScreenplayViewer({ markdown }: Props) {
	return (
		<Card className="border-border overflow-hidden">
			<div className="px-6 py-8 lg:px-10 lg:py-10">
				<ScreenplayMarkdown markdown={markdown} />
			</div>
		</Card>
	);
}
