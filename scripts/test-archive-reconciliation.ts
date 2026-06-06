/**
 * Live-DB test for reconcileArchiveCoverage (self-cleaning, no network).
 *   npx tsx --env-file=.env.local scripts/test-archive-reconciliation.ts
 * Injected whitelist + stubbed probe + stubbed webhook → deterministic, no prod mutation
 * beyond sentinel rows. Skip-guards if archive_reconciliation_runs table is absent.
 */
import { getServiceClient } from "../lib/supabase";
import { reconcileArchiveCoverage, type ReconcileSlot } from "../lib/broadcasts/archive-reconciliation";

const PAST = "2020-01-02"; // strictly past, older than real data
const CH = "shopch";
const WL = "TESTWL";
const whitelist = new Map<string, Set<string>>([["shopch", new Set([WL])], ["qvc", new Set([WL])]]);

let failures = 0;
function ok(c: boolean, m: string) { if (c) console.log(`  ok: ${m}`); else { console.error(`  FAIL: ${m}`); failures++; } }

async function main() {
  const sb = getServiceClient();

  // skip-guard: table must exist
  const probe = await sb.from("archive_reconciliation_runs").select("id").limit(1);
  if (probe.error && /relation .* does not exist/i.test(probe.error.message)) {
    console.log("SKIP: archive_reconciliation_runs table not present (apply migration first).");
    return;
  }

  async function cleanup() {
    await sb.from("broadcasts").delete().eq("channel", CH).eq("air_date", PAST);
  }
  await cleanup();

  // sentinels: video+pending→heal, video+abandoned→alert, no-video+pending→skip, archived→untouched
  const rows = [
    { start_time: "00:00:00", category: WL, video_status: "pending",  archived_video_s3: null,        title: "S-video-pending" },
    { start_time: "01:00:00", category: WL, video_status: "abandoned", archived_video_s3: null,        title: "S-video-abandoned" },
    { start_time: "02:00:00", category: WL, video_status: "pending",  archived_video_s3: null,        title: "S-novideo-pending" },
    { start_time: "03:00:00", category: WL, video_status: "archived", archived_video_s3: "k/abc.mp4", title: "S-archived" },
    { start_time: "04:00:00", category: WL, video_status: "queued",   archived_video_s3: null,        title: "S-inflight" },
  ];
  const { error: insErr } = await sb.from("broadcasts").insert(rows.map((r) => ({
    channel: CH, air_date: PAST, start_time: r.start_time, category: r.category,
    program_title: r.title, video_status: r.video_status, archived_video_s3: r.archived_video_s3,
    source_url: `https://test.invalid/recon/${r.start_time}`,
  })));
  if (insErr) { console.error("setup insert failed:", insErr.message); process.exit(1); }

  // stub probe: video exists for all sentinels EXCEPT the 02:00 "no-video" one.
  const stubProbe = async (slot: ReconcileSlot) => slot.start_time !== "02:00:00";
  const sentWebhook: object[] = [];
  const stubWebhook = async (_url: string, body: object) => { sentWebhook.push(body); return { ok: true }; };

  const result = await reconcileArchiveCoverage({
    lookbackDays: 99999, whitelist, probeVideo: stubProbe,
    webhookUrl: "https://hook.test/x", postWebhook: stubWebhook,
    now: new Date("2020-01-09T00:00:00Z"), // PAST is within window and < today(2020-01-09)
  });

  // statuses after run
  const { data: after } = await sb.from("broadcasts").select("start_time, video_status").eq("channel", CH).eq("air_date", PAST);
  const st = (t: string) => (after ?? []).find((r) => r.start_time === t)?.video_status;
  ok(st("00:00:00") === "queued", "video+pending → requeued to queued");
  ok(st("01:00:00") === "abandoned", "video+abandoned → left (alert, no resurrect)");
  ok(st("02:00:00") === "pending", "no-video+pending → untouched (skip)");
  ok(st("03:00:00") === "archived", "archived → untouched");
  ok(st("04:00:00") === "queued", "in-flight queued → untouched (not probed)");
  ok(result.healed >= 1, "result.healed counts the requeue");
  ok(result.unhealable >= 1, "result.unhealable counts the abandoned-with-video");
  ok(result.no_source >= 1, "result.no_source counts the no-video candidate");
  ok(result.alerted === true && sentWebhook.length === 1, "first run alerts (unhealable present)");

  // a run row was recorded — filter by window_to to avoid picking up future prod rows
  const { data: runs } = await sb.from("archive_reconciliation_runs")
    .select("id, unhealable").eq("window_to", "2020-01-09").order("ran_at", { ascending: false }).limit(1);
  ok((runs ?? []).length === 1 && (runs![0] as { unhealable: number }).unhealable >= 1, "run row persisted with unhealable count");

  await cleanup();
  if (failures > 0) { console.error(`\n${failures} failed.`); process.exit(1); }
  console.log("\nall live assertions passed.");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
