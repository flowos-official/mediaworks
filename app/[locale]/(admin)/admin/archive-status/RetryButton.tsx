"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";

export default function RetryButton({ broadcastId }: { broadcastId: string }) {
	const t = useTranslations("admin.archiveStatus");
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const onClick = async () => {
		setPending(true);
		setMessage(null);
		try {
			const res = await fetch(`/api/admin/broadcasts/${broadcastId}/retry-archive`, {
				method: "POST",
			});
			const json = await res.json().catch(() => ({}));
			if (!res.ok) {
				setMessage(json.error ?? `HTTP ${res.status}`);
				setPending(false);
				return;
			}
			window.location.reload();
		} catch (err) {
			setMessage(err instanceof Error ? err.message : t("retryFailed"));
			setPending(false);
		}
	};
	return (
		<div className="flex flex-col items-end gap-1">
			<button type="button" disabled={pending} onClick={onClick}
			  className="min-h-10 min-w-12 whitespace-nowrap rounded-lg border px-3 text-xs hover:bg-muted disabled:opacity-50">
				{pending ? "..." : t("retry")}
			</button>
			{message && <span className="text-xs text-red-600 max-w-[12rem] text-right">{message}</span>}
		</div>
	);
}
