"use client";
import { useState } from "react";

export default function RetryButton({ broadcastId }: { broadcastId: string }) {
	const [pending, setPending] = useState(false);
	const onClick = async () => {
		setPending(true);
		await fetch(`/api/admin/broadcasts/${broadcastId}/retry-archive`, { method: "POST" });
		window.location.reload();
	};
	return (
		<button type="button" disabled={pending} onClick={onClick}
		  className="text-xs px-2 py-1 rounded border hover:bg-gray-50 disabled:opacity-50">
			{pending ? "..." : "Retry"}
		</button>
	);
}
