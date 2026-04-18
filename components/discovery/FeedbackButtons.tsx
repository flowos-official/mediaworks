"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, Star, XCircle, Copy, Loader2 } from "lucide-react";
import { RejectDialog } from "./RejectDialog";

export type FeedbackAction = "sourced" | "interested" | "rejected" | "duplicate";
export type FeedbackState = FeedbackAction | null;

interface Props {
	productId: string;
	current: FeedbackState;
	onUpdate: (next: FeedbackState, reason?: string | null) => void;
}

const BUTTONS: Array<{
	action: FeedbackAction;
	icon: React.ReactNode;
	labelKey: "sourceButton" | "interestedButton" | "rejectedButton" | "duplicateButton";
	activeClass: string;
	hoverClass: string;
}> = [
	{
		action: "sourced",
		icon: <CheckCircle2 size={12} />,
		labelKey: "sourceButton",
		activeClass: "bg-green-500 text-white border-green-500",
		hoverClass: "hover:bg-green-50 hover:border-green-300",
	},
	{
		action: "interested",
		icon: <Star size={12} />,
		labelKey: "interestedButton",
		activeClass: "bg-orange-500 text-white border-orange-500",
		hoverClass: "hover:bg-orange-50 hover:border-orange-300",
	},
	{
		action: "rejected",
		icon: <XCircle size={12} />,
		labelKey: "rejectedButton",
		activeClass: "bg-red-500 text-white border-red-500",
		hoverClass: "hover:bg-red-50 hover:border-red-300",
	},
	{
		action: "duplicate",
		icon: <Copy size={12} />,
		labelKey: "duplicateButton",
		activeClass: "bg-gray-500 text-white border-gray-500",
		hoverClass: "hover:bg-gray-100 hover:border-gray-400",
	},
];

export function FeedbackButtons({ productId, current, onUpdate }: Props) {
	const t = useTranslations("discovery");
	const [loading, setLoading] = useState(false);
	const [rejectOpen, setRejectOpen] = useState(false);

	async function callApi(action: FeedbackAction, reason?: string) {
		setLoading(true);
		try {
			const res = await fetch("/api/discovery/feedback", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ productId, action, reason }),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			onUpdate(data.user_action as FeedbackState, reason ?? null);
		} catch (err) {
			console.error("feedback failed", err);
		} finally {
			setLoading(false);
		}
	}

	async function handleClick(action: FeedbackAction) {
		if (loading) return;
		if (action === "rejected" && current !== "rejected") {
			setRejectOpen(true);
			return;
		}
		await callApi(action);
	}

	async function handleRejectConfirm(reason: string) {
		setRejectOpen(false);
		await callApi("rejected", reason);
	}

	return (
		<>
			<div className="grid grid-cols-4 gap-1 mb-2">
				{BUTTONS.map((btn) => {
					const active = current === btn.action;
					return (
						<button
							key={btn.action}
							type="button"
							onClick={() => handleClick(btn.action)}
							disabled={loading}
							className={`inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] font-semibold rounded border transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
								active ? btn.activeClass : `bg-white text-gray-700 border-gray-200 ${btn.hoverClass}`
							}`}
						>
							{loading && active ? <Loader2 size={10} className="animate-spin" /> : btn.icon}
							<span className="hidden sm:inline">{t(btn.labelKey)}</span>
						</button>
					);
				})}
			</div>
			<RejectDialog
				open={rejectOpen}
				onConfirm={handleRejectConfirm}
				onCancel={() => setRejectOpen(false)}
			/>
		</>
	);
}
