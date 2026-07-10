"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
	BookOpenCheck,
	CheckCircle2,
	Database,
	ExternalLink,
	FileClock,
	Link2,
	Loader2,
	RadioTower,
	ShieldCheck,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { parseMarkdown } from "@/lib/screenplay/parse-markdown";
import type { ScriptCheckResult } from "@/lib/screenplay/compliance/types";
import type { ProductBrief, ScreenplayVersionRow } from "@/lib/screenplay/types";
import type { ExistingProductOption } from "./ScreenplayProductPicker";
import { VersionTimeline } from "./VersionTimeline";

type NavigatorTab = "rundown" | "sources" | "history";

interface Props {
	screenplayId: string;
	markdown: string;
	brief: ProductBrief;
	productId: string | null;
	products: ExistingProductOption[];
	versions: ScreenplayVersionRow[];
	selectedId: string | null;
	check: ScriptCheckResult | null;
	onSelectVersion: (id: string) => void;
	onJumpToLine: (line: number) => void;
	onProductLinked: (productId: string, brief: ProductBrief) => void;
}

const TABS: { id: NavigatorTab; label: string; icon: typeof RadioTower }[] = [
	{ id: "rundown", label: "構成", icon: RadioTower },
	{ id: "sources", label: "根拠", icon: Database },
	{ id: "history", label: "履歴", icon: FileClock },
];

function briefFactCount(brief: ProductBrief): number {
	return [
		brief.name,
		brief.category,
		brief.description,
		brief.price?.listJpy,
		brief.price?.saleJpy,
		brief.price?.shippingJpy,
		brief.guarantee,
		brief.notes,
		...(brief.bonuses ?? []),
	].filter((value) => value !== undefined && value !== null && value !== "").length;
}

export function ScreenplayNavigator({
	screenplayId,
	markdown,
	brief,
	productId,
	products,
	versions,
	selectedId,
	check,
	onSelectVersion,
	onJumpToLine,
	onProductLinked,
}: Props) {
	const [tab, setTab] = useState<NavigatorTab>("rundown");
	const [selectedProduct, setSelectedProduct] = useState("");
	const [linking, setLinking] = useState(false);
	const [linkError, setLinkError] = useState<string | null>(null);
	const linkedProduct = products.find((product) => product.id === productId) ?? null;

	const rundown = useMemo(
		() =>
			parseMarkdown(markdown)
				.filter(
					(block) =>
						block.kind === "heading" &&
						(block.level === 2 || block.level === 3) &&
						!block.text.includes("メタ情報") &&
						!block.text.includes("スタイル・コンプライアンス"),
				)
				.slice(0, 18)
				.map((block, index) => ({
					label: block.kind === "heading" ? block.text.replace(/^■/, "") : "",
					line: block.line ?? 0,
					index,
				})),
		[markdown],
	);

	async function linkProduct() {
		if (!selectedProduct) return;
		setLinking(true);
		setLinkError(null);
		try {
			const response = await fetch(`/api/screenplays/${screenplayId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ productId: selectedProduct }),
			});
			const payload = (await response.json()) as {
				productId?: string;
				brief?: ProductBrief;
				error?: string;
			};
			if (!response.ok || !payload.productId || !payload.brief) {
				throw new Error(payload.error ?? "商品を連携できませんでした");
			}
			onProductLinked(payload.productId, payload.brief);
			setSelectedProduct("");
		} catch (cause) {
			setLinkError(cause instanceof Error ? cause.message : "商品を連携できませんでした");
		} finally {
			setLinking(false);
		}
	}

	const factCount = briefFactCount(brief);
	const referenceCount = check?.grounding?.referencesSnapshot?.length ?? 0;

	return (
		<Card className="overflow-hidden border-border bg-card/95">
			<div className="grid grid-cols-3 border-b border-border bg-muted/40 p-1">
				{TABS.map((item) => {
					const Icon = item.icon;
					const active = item.id === tab;
					return (
						<button
							key={item.id}
							type="button"
							onClick={() => setTab(item.id)}
							className={`inline-flex items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition ${
								active
									? "bg-background text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							<Icon size={12} /> {item.label}
						</button>
					);
				})}
			</div>

			<CardContent className="p-3">
				{tab === "rundown" && (
					<div>
						<div className="mb-2 flex items-center justify-between px-1">
							<span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
								放送ランダウン
							</span>
							<span className="font-mono text-[10px] text-muted-foreground">{rundown.length} scenes</span>
						</div>
						<ol className="space-y-1">
							{rundown.map((item) => (
								<li key={`${item.line}-${item.label}`}>
									<button
										type="button"
										onClick={() => onJumpToLine(item.line)}
										className="group grid w-full grid-cols-[28px_1fr] items-start gap-2 rounded-lg px-2 py-2 text-left text-xs transition hover:bg-blue-600/[0.07]"
									>
										<span className="font-mono text-[10px] tabular-nums text-blue-600">
											{String(item.index + 1).padStart(2, "0")}
										</span>
										<span className="line-clamp-2 leading-snug text-foreground">{item.label}</span>
									</button>
								</li>
							))}
						</ol>
					</div>
				)}

				{tab === "sources" && (
					<div className="space-y-3">
						<div className="rounded-xl border border-border bg-background p-3">
							<div className="flex items-start gap-2.5">
								<div className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg ${productId ? "bg-emerald-600/10 text-emerald-600" : "bg-amber-600/10 text-amber-600"}`}>
									{productId ? <CheckCircle2 size={14} /> : <Link2 size={14} />}
								</div>
								<div className="min-w-0">
									<div className="text-xs font-semibold text-foreground">
										{productId ? "MediaWorks商品と連携済み" : "商品データ未連携"}
									</div>
									<p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
										{productId
											? linkedProduct?.name ?? brief.name
											: "商品を連携すると、調査済みの事実を固定コンテキストとして利用できます。"}
									</p>
									{productId && (
										<Link
											href={`/products/${productId}`}
											className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 hover:underline"
										>
											商品レポート <ExternalLink size={10} />
										</Link>
									)}
								</div>
							</div>
						</div>

						{!productId && products.length > 0 && (
							<div className="space-y-2 rounded-xl border border-dashed border-border p-3">
								<label htmlFor="screenplay-product-link" className="text-[11px] font-medium text-foreground">
									既存商品を連携
								</label>
								<select
									id="screenplay-product-link"
									value={selectedProduct}
									onChange={(event) => setSelectedProduct(event.target.value)}
									className="h-9 w-full rounded-lg border border-border bg-background px-2 text-xs text-foreground"
								>
									<option value="">商品を選択</option>
									{products.map((product) => (
										<option key={product.id} value={product.id}>{product.name}</option>
									))}
								</select>
								<button
									type="button"
									onClick={() => void linkProduct()}
									disabled={!selectedProduct || linking}
									className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
								>
									{linking ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />}
									商品データを連携
								</button>
								{linkError && <p className="text-[11px] text-red-600">{linkError}</p>}
							</div>
						)}

						<div className="grid grid-cols-2 gap-2">
							<div className="rounded-lg border border-border bg-background p-2.5">
								<div className="font-mono text-lg font-semibold text-foreground">{factCount}</div>
								<div className="text-[10px] text-muted-foreground">固定コンテキスト</div>
							</div>
							<div className="rounded-lg border border-border bg-background p-2.5">
								<div className="font-mono text-lg font-semibold text-foreground">{referenceCount}</div>
								<div className="text-[10px] text-muted-foreground">考査参照資料</div>
							</div>
						</div>

						<div className="space-y-1.5 text-[11px]">
							<div className="flex items-start gap-2 rounded-lg bg-emerald-600/[0.07] px-2.5 py-2 text-foreground">
								<ShieldCheck size={12} className="mt-0.5 shrink-0 text-emerald-600" />
								<span>商品名・カテゴリ・価格・特典を改稿時も参照</span>
							</div>
							<div className="flex items-start gap-2 rounded-lg bg-blue-600/[0.07] px-2.5 py-2 text-foreground">
								<BookOpenCheck size={12} className="mt-0.5 shrink-0 text-blue-600" />
								<span>{check?.grounding?.factSearch ? "公開情報のファクト検索済み" : "公開情報のファクト検索は未実行"}</span>
							</div>
						</div>
					</div>
				)}

				{tab === "history" && (
					<div>
						<div className="mb-3 flex items-center justify-between px-1">
							<span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">改稿履歴</span>
							<span className="font-mono text-[10px] text-muted-foreground">{versions.length}</span>
						</div>
						<VersionTimeline
							versions={versions.map((version) => ({
								id: version.id,
								version_number: version.version_number,
								feedback: version.feedback,
								created_at: version.created_at,
							}))}
							selectedId={selectedId}
							onSelect={onSelectVersion}
						/>
					</div>
				)}
			</CardContent>
		</Card>
	);
}

