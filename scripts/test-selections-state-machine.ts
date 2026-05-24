/**
 * Smoke: state-machine invariants on product_selections.
 * Uses the service client; cleans up after itself.
 *
 * Run: npm run test:selections
 */
import { getServiceClient } from "../lib/supabase";

const sb = getServiceClient();
let failures = 0;

function check(cond: boolean, label: string) {
  if (cond) console.log(`PASS: ${label}`);
  else {
    console.error(`FAIL: ${label}`);
    failures++;
  }
}

async function main() {
  const { data: run } = await sb
    .from("discovery_runs")
    .insert({
      status: "completed", target_count: 1, produced_count: 1,
      exploration_ratio: 0, iterations: 1, context: "home_shopping",
    })
    .select("id").single();
  if (!run) throw new Error("could not create discovery_runs");

  const { data: dp } = await sb
    .from("discovered_products")
    .insert({
      session_id: run.id, name: "SM Test", name_normalized: "smtest",
      product_url: `https://example.test/sm/${Date.now()}`,
      source: "other", seed_keyword: "sm-test",
      tv_fit_score: 0, tv_fit_reason: "test", track: "exploration",
      context: "home_shopping", is_tv_applicable: true, is_live_applicable: false,
    })
    .select("id").single();
  if (!dp) throw new Error("could not create discovered_products");

  const { data: profile } = await sb.from("profiles").select("id").limit(1).single();
  if (!profile) throw new Error("no profile available — seed a profile first");

  const { data: sel } = await sb
    .from("product_selections")
    .insert({ discovered_product_id: dp.id, status: "selected", owner_id: profile.id })
    .select("id").single();
  check(!!sel, "create selection in 'selected'");
  if (!sel) {
    await cleanup(run.id);
    return;
  }

  const dupe = await sb
    .from("product_selections")
    .insert({ discovered_product_id: dp.id, status: "selected", owner_id: profile.id });
  check(!!dupe.error, "second active selection rejected by partial unique");

  const badScheduled = await sb
    .from("product_selections")
    .update({ status: "scheduled" })
    .eq("id", sel.id);
  check(!!badScheduled.error, "scheduled without anchor rejected");

  const okScheduled = await sb
    .from("product_selections")
    .update({ status: "scheduled", scheduled_note: "manual" })
    .eq("id", sel.id);
  check(!okScheduled.error, "scheduled with scheduled_note accepted");

  const badClose = await sb
    .from("product_selections")
    .update({ status: "closed" })
    .eq("id", sel.id);
  check(!!badClose.error, "closed without reason rejected");

  const okClose = await sb
    .from("product_selections")
    .update({ status: "closed", closed_reason: "dropped", closed_at: new Date().toISOString() })
    .eq("id", sel.id);
  check(!okClose.error, "closed with reason accepted");

  const reSel = await sb
    .from("product_selections")
    .insert({ discovered_product_id: dp.id, status: "selected", owner_id: profile.id });
  check(!reSel.error, "new selection after close accepted (re-selection)");

  await cleanup(run.id);
}

async function cleanup(runId: string) {
  // discovered_products has ON DELETE CASCADE for the session → product_selections cascades.
  // Delete in safe order anyway in case constraints differ.
  await sb.from("product_selections").delete().eq("status", "selected").eq("discovered_product_id",
    (await sb.from("discovered_products").select("id").eq("session_id", runId).maybeSingle()).data?.id ?? "");
  await sb.from("discovered_products").delete().eq("session_id", runId);
  await sb.from("discovery_runs").delete().eq("id", runId);
}

main()
  .then(() => { if (failures > 0) process.exit(1); })
  .catch((e) => { console.error(e); process.exit(1); });
