/**
 * Outcome-driven archive coverage reconciliation. Spec:
 * docs/superpowers/specs/2026-06-06-archive-reconciliation-design.md
 * NOTE: intentionally NO `import "server-only"` — imported by tsx smoke scripts.
 */

export type VideoStatus =
  | "pending" | "queued" | "downloading" | "archived"
  | "deferred" | "failed_unsupported" | "abandoned" | "failed";

export type CandidateAction = "requeue" | "alert" | "skip";

const HEALABLE: ReadonlySet<VideoStatus> = new Set(["pending", "deferred"]);
const TERMINAL_FAIL: ReadonlySet<VideoStatus> = new Set(["abandoned", "failed", "failed_unsupported"]);

/** Decision for a stuck, non-archived candidate (queued/downloading/archived are
 *  filtered out before this is called). */
export function classifyCandidate(status: VideoStatus, videoExists: boolean): CandidateAction {
  if (!videoExists) return "skip";        // no source → not a gap
  if (HEALABLE.has(status)) return "requeue";
  if (TERMINAL_FAIL.has(status)) return "alert"; // real video, terminal failure
  return "skip";
}
