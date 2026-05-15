// lib/screenplay/types.ts
export type GenerationMode = "initial" | "refine";

export type ProgressEvent =
  | { type: "step"; name: string; status: "started" | "completed" | "failed"; detail?: string }
  | { type: "chunk"; chars: number }
  | { type: "done"; screenplayId: string; versionId: string; versionNumber: number }
  | { type: "error"; message: string };

export interface ProductBrief {
  name: string;
  category?: string;
  description: string;
  price?: { listJpy?: number; saleJpy?: number; shippingJpy?: number };
  bonuses?: string[];
  guarantee?: string;
  notes?: string;
}

export interface GenerateInput {
  mode: GenerationMode;
  productBrief: ProductBrief;
  feedback?: string;
  previousMarkdown?: string;
}

export interface GenerationResult {
  markdown: string;
  model: string;
  thinkingLevel: string;
  tokenUsage?: { input?: number; output?: number };
}

export interface ScreenplayRow {
  id: string;
  product_id: string | null;
  title: string;
  product_info_snapshot: ProductBrief;
  current_version_id: string | null;
  status: "pending" | "generating" | "ready" | "failed";
  last_run_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScreenplayVersionRow {
  id: string;
  screenplay_id: string;
  version_number: number;
  markdown: string;
  feedback: string | null;
  base_version_id: string | null;
  model: string;
  thinking_level: string;
  token_usage: { input?: number; output?: number } | null;
  created_at: string;
}
