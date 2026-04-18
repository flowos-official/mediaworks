"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";

const REASON_KEYS = [
	"rejectReason_priceMismatch",
	"rejectReason_categorySaturated",
	"rejectReason_alreadyBroadcast",
	"rejectReason_qualityConcern",
	"rejectReason_other",
] as const;

type ReasonKey = (typeof REASON_KEYS)[number];

const REASON_VALUE: Record<ReasonKey, string> = {
	rejectReason_priceMismatch: "価格帯不適合",
	rejectReason_categorySaturated: "カテゴリ過飽和",
	rejectReason_alreadyBroadcast: "既に放送中",
	rejectReason_qualityConcern: "品質懸念",
	rejectReason_other: "その他",
};

export function RejectDialog({
	open,
	onConfirm,
	onCancel,
}: {
	open: boolean;
	onConfirm: (reason: string) => void;
	onCancel: () => void;
}) {
	const t = useTranslations("discovery");
	const [selected, setSelected] = useState<ReasonKey>(REASON_KEYS[0]);
	const [otherText, setOtherText] = useState("");
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	if (!open || !mounted) return null;

	const isOther = selected === "rejectReason_other";
	const trimmed = otherText.trim();
	const canConfirm = !isOther || trimmed.length > 0;

	function handleConfirm() {
		if (isOther) {
			onConfirm(trimmed ? `その他: ${trimmed}` : "その他");
		} else {
			onConfirm(REASON_VALUE[selected]);
		}
	}

	const dialog = (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
			onClick={onCancel}
		>
			<div
				className="bg-white rounded-lg shadow-lg p-5 w-full max-w-sm mx-4"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between mb-3">
					<h3 className="text-sm font-semibold text-gray-900">
						{t("rejectDialogTitle")}
					</h3>
					<button
						type="button"
						onClick={onCancel}
						className="text-gray-400 hover:text-gray-600"
					>
						<X size={16} />
					</button>
				</div>

				<div className="space-y-2 mb-5">
					{REASON_KEYS.map((key) => (
						<div key={key}>
							<label
								className={`flex items-center gap-2 px-3 py-2 rounded border cursor-pointer transition-colors ${
									selected === key
										? "bg-red-50 border-red-300"
										: "bg-white border-gray-200 hover:bg-gray-50"
								}`}
							>
								<input
									type="radio"
									name="rejectReason"
									value={key}
									checked={selected === key}
									onChange={() => setSelected(key)}
									className="accent-red-500"
								/>
								<span className="text-xs text-gray-800">{t(key)}</span>
							</label>
							{key === "rejectReason_other" && isOther && (
								<textarea
									autoFocus
									value={otherText}
									onChange={(e) => setOtherText(e.target.value)}
									placeholder="理由を入力..."
									rows={2}
									className="w-full mt-2 px-3 py-2 text-xs border border-red-300 rounded resize-none focus:outline-none focus:ring-1 focus:ring-red-400"
								/>
							)}
						</div>
					))}
				</div>

				<div className="flex justify-end gap-2">
					<button
						type="button"
						onClick={onCancel}
						className="px-4 py-1.5 text-xs text-gray-700 border border-gray-200 rounded hover:bg-gray-50"
					>
						{t("cancel")}
					</button>
					<button
						type="button"
						onClick={handleConfirm}
						disabled={!canConfirm}
						className="px-4 py-1.5 text-xs bg-red-500 text-white rounded hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{t("confirm")}
					</button>
				</div>
			</div>
		</div>
	);

	return createPortal(dialog, document.body);
}
