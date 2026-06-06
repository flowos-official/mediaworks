/**
 * Live-DB test for reconcileArchiveCoverage mode:"heal" (self-cleaning, no network).
 *   npx tsx --env-file=.env.local scripts/test-archive-reconciliation-heal.ts
 * Heal mode must requeue healable slots but SKIP coverage/record/alert: no
 * archive_reconciliation_runs row, no webhook. Isolated from the audit test by a
 * distinct sentinel date (2020-01-03) and window (now=2020-01-10).
 */
import { getServiceClient } from "../lib/supabase";
import { reconcileArchiveCoverage, type ReconcileSlot } from "../lib/broadcasts/archive-reconciliation";

const PAST = "2020-01-03"; // distinct from the audit test's 2020-01-02
const HEAL_WINDOW_TO = "2020-01-10";
const CH = "shopch";
const WL = "TESTWL";
const whitelist = new Map<string, Set<string>>([["shopch", new Set([WL])], ["qvc", new Set([WL])]]);

let failures = 0;
function ok(c: boolean, m: string) { if (c) console.log(`  ok: ${m}`); else { console.error(`  FAIL: ${m}`); failures++; } }

async function main() {
  const sb = getServiceClient();

  const probe = await sb.from("archive_reconciliation_runs").select("id").limit(1);
  if (probe.error && /relation .* does not exist/i.test(probe.error.message)) {
    console.log("SKIP: archive_reconciliation_runs table not present (apply migration first).");
    return;
  }

  async function cleanup() {
    await sb.from("broadcasts").delete().eq("channel", CH).eq("air_date", PAST);
  }
  await cleanup();

  const rows = [
    { start_time: "00:00:00", category: WL, video_status: "pending",   archived_video_s3: null, title: "H-video-pending" },
    { start_time: "01:00:00", category: WL, video_status: "abandoned", archived_video_s3: null, title: "H-video-abandoned" },
    { start_time: "02:00:00", category: WL, video_status: "pending",   archived_video_s3: null, title: "H-novideo-pending" },
  ];
  const { error: insErr } = await sb.from("broadcasts").insert(rows.map((r) => ({
    channel: CH, air_date: PAST, start_time: r.start_time, category: r.category,
    program_title: r.title, video_status: r.video_status, archived_video_s3: r.archived_video_s3,
    source_url: `https://test.invalid/recon-heal/${r.start_time}`,
  })));
  if (insErr) { console.error("setup insert failed:", insErr.message); process.exit(1); }

  const stubProbe = async (slot: ReconcileSlot) => slot.start_time !== "02:00:00"; // 02:00 has no video
  const sentWebhook: object[] = [];
  const stubWebhook = async (_url: string, body: object) => { sentWebhook.push(body); return { ok: true }; };

  const result = await reconcileArchiveCoverage({
    mode: "heal",
    lookbackDays: 99999, whitelist, probeVideo: stubProbe,
    webhookUrl: "https://hook.test/x", postWebhook: stubWebhook,
    now: new Date(`${HEAL_WINDOW_TO}T00:00:00Z`),
  });

  const { data: after } = await sb.from("broadcasts").select("start_time, video_status").eq("channel", CH).eq("air_date", PAST);
  const st = (t: string) => (after ?? []).find((r) => r.start_time === t)?.video_status;
  ok(st("00:00:00") === "queued", "heal: video+pending → requeued to queued");
  ok(st("01:00:00") === "abandoned", "heal: video+abandoned → untouched (no resurrect)");
  ok(st("02:00:00") === "pending", "heal: no-video+pending → untouched");
  ok(result.healed >= 1, "heal: result.healed counts the requeue");
  ok(result.unhealable === 0, "heal: unhealable is 0 (audit-only)");
  ok(result.no_source >= 1, "heal: no_source counts the no-video candidate");
  ok(result.alerted === false && sentWebhook.length === 0, "heal: NO webhook sent");

  // heal mode must NOT persist a run row for its window
  const { data: runs } = await sb.from("archive_reconciliation_runs").select("id").eq("window_to", HEAL_WINDOW_TO);
  ok((runs ?? []).length === 0, "heal: NO archive_reconciliation_runs row inserted");

  await cleanup();
  if (failures > 0) { console.error(`\n${failures} failed.`); process.exit(1); }
  console.log("\nall heal-mode assertions passed.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
