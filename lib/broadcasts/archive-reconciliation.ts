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

export interface DayTally { channel: string; air_date: string; archived: number; gapsWithVideo: number; }
export interface CoverageDay { channel: string; air_date: string; expected: number; archived: number; coverage: number; }

/** Coverage per (channel, air_date). expected = archived + video-exists gaps
 *  (no-source + in-flight already excluded by the caller). expected==0 → 100 (n/a). */
export function computeCoverage(tallies: DayTally[]): CoverageDay[] {
  return tallies.map((t) => {
    const expected = t.archived + t.gapsWithVideo;
    const coverage = expected === 0 ? 100 : Math.round((t.archived / expected) * 1000) / 10;
    return { channel: t.channel, air_date: t.air_date, expected, archived: t.archived, coverage };
  });
}

export interface GapRecord {
  broadcast_id: string;
  channel: string;
  air_date: string;
  start_time: string;
  status: string;
  classification: "healed" | "unhealable";
  reason: string;
}

/** A gap is alert-worthy if it is a terminal failure with a real video
 *  (classification 'unhealable'), OR it was already a gap in the previous run
 *  (requeued last cycle but still not archived → not healing). */
export function selectAlertWorthy(gaps: GapRecord[], previousGapIds: Set<string>): GapRecord[] {
  return gaps.filter((g) => g.classification === "unhealable" || previousGapIds.has(g.broadcast_id));
}

/** Slack/Discord-compatible message body (text=Slack, content=Discord, identical). */
export function buildWebhookPayload(
  alertGaps: GapRecord[],
  coverage: CoverageDay[],
): { text: string; content: string } {
  const lines = [
    `🚨 Archive reconciliation — ${alertGaps.length} un-healable gap${alertGaps.length === 1 ? "" : "s"} (video exists, not archived)`,
  ];
  for (const g of alertGaps.slice(0, 20)) {
    lines.push(`  • [${g.channel}] ${g.air_date} ${g.start_time} — ${g.reason}`);
  }
  if (alertGaps.length > 20) lines.push(`  … and ${alertGaps.length - 20} more`);
  const byCh = new Map<string, { archived: number; expected: number }>();
  for (const c of coverage) {
    const e = byCh.get(c.channel) ?? { archived: 0, expected: 0 };
    e.archived += c.archived;
    e.expected += c.expected;
    byCh.set(c.channel, e);
  }
  const cov = [...byCh.entries()]
    .map(([ch, e]) => `${ch} ${e.expected === 0 ? 100 : Math.round((e.archived / e.expected) * 100)}% (${e.archived}/${e.expected})`)
    .join(" · ");
  lines.push(`Coverage (7d): ${cov}`);
  lines.push(`→ /admin/archive-status`);
  const msg = lines.join("\n");
  return { text: msg, content: msg };
}
