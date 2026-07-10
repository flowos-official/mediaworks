// lib/screenplay/types.ts
export type GenerationMode = "initial" | "refine" | "import";

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
  // User-customizable knobs (all optional — sane defaults when absent).
  customization?: {
    runtimeMinutes?: number;             // target broadcast length (default 25)
    targetAudience?: string;             // free-text audience description override
    keyMessage?: string;                 // single-line elevator pitch the writer must echo
    mustDemos?: string[];                // demos the script MUST include
    mustAvoid?: string[];                // things the script MUST NOT do (claims, tone, etc.)
    extraSpeakers?: { role: string; description: string }[];   // additional speakers beyond defaults
    tonalAdjust?: "calm" | "neutral" | "energetic";            // delivery energy override
  };
}

export interface GenerateInput {
  mode: GenerationMode;
  productBrief: ProductBrief;
  feedback?: string;
  previousMarkdown?: string;
  /** Pre-built compliance block (feature A) injected verbatim into the prompt.
   *  Empty/undefined → not injected. Built by buildGenerationComplianceBlock. */
  complianceBlock?: string;
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
  source_kind?: "upload" | "url" | "import" | "product" | null;
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
  change_notes: ChangeNotes | null;
  created_at: string;
}

// ── Version diff (変更点レビュー) ───────────────────────────────────────────
export interface DiffLine {
  type: "context" | "added" | "removed";
  text: string;
}
export interface DiffHunk {
  index: number;       // stable ordinal; aligns client render ↔ server rationale
  lines: DiffLine[];
  newStart?: number;   // 0-based start line in the NEW doc — for hunk→script jump
}
export interface HunkReason {
  index: number;       // matches DiffHunk.index
  reason: string;
}
/** Cache invalidation key for change_notes — any field change forces recompute. */
export interface ChangeNotesKey {
  diffVersion: number;
  promptVersion: number;
  model: string;
  baseVersionId: string;
  baseCheckId: string | null;
  hunkCount: number;
}
/** Persisted in screenplay_versions.change_notes — written only on success. */
export interface ChangeNotes {
  ok: true;
  key: ChangeNotesKey;
  rationale: HunkReason[];
  computedAt: string;
}
