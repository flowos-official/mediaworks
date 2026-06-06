/**
 * Outcome-driven archive coverage reconciliation. Spec:
 * docs/superpowers/specs/2026-06-06-archive-reconciliation-design.md
 * NOTE: intentionally NO `import "server-only"` — imported by tsx smoke scripts.
 */

import { getServiceClient } from "@/lib/supabase";
import { loadWhitelist, isAllowed } from "./category-filter";
import { buildProgramId } from "./shopch-json";

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

export interface ReconcileSlot {
  id: string;
  channel: "qvc" | "shopch";
  air_date: string;
  start_time: string;
  program_title: string | null;
  category: string | null;
  product_ids: string[] | null;
  video_status: VideoStatus;
  archived_video_s3: string | null;
  video_download_attempts: number | null;
}

export interface ReconcileResult {
  window_from: string;
  window_to: string;
  expected_total: number;
  archived_total: number;
  coverage_pct: number;
  healed: number;
  unhealable: number;
  no_source: number;
  probed: number;
  coverage_by_day: CoverageDay[];
  gaps: GapRecord[];
  alerted: boolean;
  alert_error: string | null;
  duration_ms: number;
}

type ProbeFn = (slot: ReconcileSlot) => Promise<boolean>;
type WebhookFn = (url: string, body: object) => Promise<{ ok: boolean; error?: string }>;

export interface ReconcileOptions {
  mode?: "audit" | "heal";
  lookbackDays?: number;
  whitelist?: Map<string, Set<string>>;
  probeVideo?: ProbeFn;
  postWebhook?: WebhookFn;
  webhookUrl?: string;
  now?: Date;
}

const STUCK: ReadonlySet<VideoStatus> = new Set(["pending", "deferred", "abandoned", "failed", "failed_unsupported"]);
const PAGE = 1000;

function jstDate(now: Date, offsetDays: number): string {
  return new Date(now.getTime() + 9 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

/** Default probe: QVC = lead product video_url present (DB); ShopCh = m3u8 200/206 (HTTP). */
export async function defaultProbeVideo(slot: ReconcileSlot): Promise<boolean> {
  if (slot.channel === "qvc") {
    const pid = slot.product_ids?.[0];
    if (!pid) return false;
    const sb = getServiceClient();
    const { data } = await sb.from("qvc_products").select("video_url").eq("id", pid).maybeSingle();
    return !!(data as { video_url: string | null } | null)?.video_url;
  }
  const programId = buildProgramId(slot.air_date, slot.start_time);
  const url = `https://www.shopch.jp/m3u8/prog/${programId}/${programId}_jwplayer.m3u8`;
  try {
    const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-0" } });
    return res.status === 200 || res.status === 206;
  } catch {
    return false;
  }
}

async function loadPreviousGapIds(sb: ReturnType<typeof getServiceClient>): Promise<Set<string>> {
  const { data } = await sb
    .from("archive_reconciliation_runs")
    .select("gaps")
    .order("ran_at", { ascending: false })
    .limit(1);
  const row = (data ?? [])[0] as { gaps: GapRecord[] } | undefined;
  return new Set((row?.gaps ?? []).map((g) => g.broadcast_id));
}

export async function reconcileArchiveCoverage(opts?: ReconcileOptions): Promise<ReconcileResult> {
  const sb = getServiceClient();
  const now = opts?.now ?? new Date();
  const t0 = Date.now();
  const lookbackDays = opts?.lookbackDays ?? (Number(process.env.RECONCILE_LOOKBACK_DAYS) || 7);
  const whitelist = opts?.whitelist ?? (await loadWhitelist());
  const probeVideo = opts?.probeVideo ?? defaultProbeVideo;
  const postWebhookFn = opts?.postWebhook;
  const webhookUrl = opts?.webhookUrl ?? process.env.ALERT_WEBHOOK_URL ?? "";
  const mode = opts?.mode ?? "audit";

  const window_to = jstDate(now, 0);      // exclusive (today)
  const window_from = jstDate(now, -lookbackDays);

  try {
    // load whitelist slots in window
    const slots: ReconcileSlot[] = [];
    let offset = 0;
    for (;;) {
      const { data, error } = await sb
        .from("broadcasts")
        .select("id, channel, air_date, start_time, program_title, category, product_ids, video_status, archived_video_s3, video_download_attempts")
        .in("channel", ["qvc", "shopch"])
        .gte("air_date", window_from)
        .lt("air_date", window_to)
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`[reconcile] load failed: ${error.message}`);
      const batch = (data ?? []) as ReconcileSlot[];
      slots.push(...batch.filter((s) => isAllowed(whitelist, s.channel, s.category)));
      if (batch.length < PAGE) break;
      offset += PAGE;
    }

    // per-day tallies + gaps
    const tallyKey = (s: ReconcileSlot) => `${s.channel}|${s.air_date}`;
    const archivedByDay = new Map<string, number>();
    const gapsByDay = new Map<string, number>();
    const gaps: GapRecord[] = [];
    let healed = 0, unhealable = 0, no_source = 0, probed = 0;

    for (const s of slots) {
      const k = tallyKey(s);
      if (s.archived_video_s3 || s.video_status === "archived") {
        archivedByDay.set(k, (archivedByDay.get(k) ?? 0) + 1);
        continue;
      }
      if (!STUCK.has(s.video_status)) continue; // queued/downloading → in-flight, skip
      probed++;
      const hasVideo = await probeVideo(s);
      const action = classifyCandidate(s.video_status, hasVideo);
      if (action === "skip") { no_source++; continue; } // no source video
      gapsByDay.set(k, (gapsByDay.get(k) ?? 0) + 1);
      if (action === "requeue") {
        const { data: upd } = await sb
          .from("broadcasts")
          .update({ video_status: "queued", video_error: null })
          .eq("id", s.id)
          .in("video_status", ["pending", "deferred"]) // CAS
          .select("id");
        if (upd && upd.length > 0) healed++;
        gaps.push({ broadcast_id: s.id, channel: s.channel, air_date: s.air_date, start_time: s.start_time, status: s.video_status, classification: "healed", reason: "requeued (video present)" });
      } else { // alert
        unhealable++;
        gaps.push({ broadcast_id: s.id, channel: s.channel, air_date: s.air_date, start_time: s.start_time, status: s.video_status, classification: "unhealable", reason: `${s.video_status}, video present` });
      }
    }

    // heal mode: requeue only — skip coverage/record/alert (the daily audit run owns those).
    // unhealable/gaps ARE computed by the loop above but are intentionally dropped here
    // (returned 0/[]); only the audit run records & alerts on them. `healed` is the sole
    // signal the every-2h cron consumes from heal mode.
    if (mode === "heal") {
      return {
        window_from, window_to,
        expected_total: 0, archived_total: 0, coverage_pct: 0,
        healed, unhealable: 0, no_source, probed,
        coverage_by_day: [], gaps: [],
        alerted: false, alert_error: null,
        duration_ms: Date.now() - t0,
      };
    }

    // coverage
    const dayKeys = new Set<string>([...archivedByDay.keys(), ...gapsByDay.keys()]);
    const tallies: DayTally[] = [...dayKeys].map((k) => {
      const [channel, air_date] = k.split("|");
      return { channel, air_date, archived: archivedByDay.get(k) ?? 0, gapsWithVideo: gapsByDay.get(k) ?? 0 };
    });
    const coverage_by_day = computeCoverage(tallies).sort((a, b) => (a.air_date + a.channel).localeCompare(b.air_date + b.channel));
    const expected_total = coverage_by_day.reduce((n, c) => n + c.expected, 0);
    const archived_total = coverage_by_day.reduce((n, c) => n + c.archived, 0);
    // coverage_pct is 2dp to fit the numeric(5,2) column; computeCoverage's per-day
    // values are 1dp (display) and buildWebhookPayload's summary is whole-percent.
    const coverage_pct = expected_total === 0 ? 100 : Math.round((archived_total / expected_total) * 10000) / 100;

    // alert
    const prevGapIds = await loadPreviousGapIds(sb);
    const alertGaps = selectAlertWorthy(gaps, prevGapIds);
    let alerted = false;
    let alert_error: string | null = null;
    if (alertGaps.length > 0 && webhookUrl) {
      const sender = postWebhookFn ?? (await import("@/lib/alerts/webhook")).postWebhook;
      const body = buildWebhookPayload(alertGaps, coverage_by_day);
      const r = await sender(webhookUrl, body);
      alerted = r.ok;
      alert_error = r.ok ? null : (r.error ?? "unknown webhook error");
    } else if (alertGaps.length > 0 && !webhookUrl) {
      alert_error = "ALERT_WEBHOOK_URL unset";
    }

    const duration_ms = Date.now() - t0;
    const result: ReconcileResult = {
      window_from, window_to, expected_total, archived_total, coverage_pct,
      healed, unhealable, no_source, probed, coverage_by_day, gaps, alerted, alert_error,
      duration_ms,
    };

    // persist
    const { error: insErr } = await sb.from("archive_reconciliation_runs").insert({
      ran_at: now.toISOString(),
      window_from, window_to, channels: ["qvc", "shopch"],
      expected_total, archived_total, coverage_pct,
      healed, unhealable, no_source, probed,
      coverage_by_day, gaps, alerted, alert_error,
      duration_ms,
    });
    if (insErr) console.warn("[reconcile] run insert failed:", insErr.message);

    return result;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      await sb.from("archive_reconciliation_runs").insert({
        ran_at: now.toISOString(), window_from, window_to, channels: ["qvc", "shopch"],
        error: msg, duration_ms: Date.now() - t0,
      });
    } catch { /* best-effort audit; never mask the original error */ }
    throw e;
  }
}
