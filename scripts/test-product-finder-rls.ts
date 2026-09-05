/**
 * Ask the database, as a real user, whether the writes this feature makes are
 * actually permitted.
 *
 * This exists because two green suites hid a total outage. `test:product-finder-live`
 * runs everything through the SERVICE client, which bypasses RLS entirely, so
 * it passed while every real request returned 500: the run service was writing
 * knowledge_snapshots — an intelligence-foundation table whose write side is
 * service-role by design — through the user's client. Nothing in a static
 * check or a service-role integration test can see that.
 *
 * The probe impersonates a member/admin exactly as PostgREST does, by setting
 * `role` and `request.jwt.claims`, and asserts both directions: the writes that
 * must succeed, and the one that must stay blocked.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runManagementSql } from "./apply-sql-via-management-api";

const PROBE = `
create temp table probe(step text, result text) on commit drop;
grant all on probe to authenticated;

do $$
declare uid uuid; rid uuid; n integer;
begin
  select id into uid from profiles where role in ('member','admin') limit 1;
  insert into probe values ('profile', coalesce(uid::text,'NONE'));
  if uid is null then return; end if;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claims',
    json_build_object('sub', uid::text, 'role','authenticated')::text, true);
  insert into probe values ('role', coalesce(public.current_user_role(),'null'));

  begin
    insert into product_recommendation_runs (created_by, mode, query_json, status, algorithm_version)
    values (uid,'stored_only','{"limit":5}'::jsonb,'running','rls-probe') returning id into rid;
    insert into probe values ('run_insert','ALLOWED');
  exception when others then
    insert into probe values ('run_insert','BLOCKED: '||SQLERRM);
  end;

  if rid is not null then
    begin
      insert into product_recommendation_items
        (run_id, canonical_product_id, rank, opportunity_index, axes, confidence, reasons, risks, missing_data)
      select rid, cp.id, 1, 0.5, '[]'::jsonb,'{}'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb
      from canonical_products cp limit 1;
      insert into probe values ('item_insert','ALLOWED');
    exception when others then
      insert into probe values ('item_insert','BLOCKED: '||SQLERRM);
    end;

    -- The update failRun() actually performs. Deliberately not the completion
    -- update: that one needs a knowledge_snapshot_id the user cannot create,
    -- and its CHECK would fail for a reason that has nothing to do with RLS.
    begin
      update product_recommendation_runs
        set status='failed', error_code='rls_probe'
        where id = rid;
      -- Row count, not the absence of an exception. RLS does not RAISE on a
      -- disallowed UPDATE or DELETE — it narrows the rows the statement can
      -- see, so a blocked write reports success having touched nothing. A
      -- probe that watches for an exception reads that as "allowed".
      get diagnostics n = row_count;
      insert into probe values ('run_update', case when n = 1 then 'ALLOWED' else 'BLOCKED (0 rows)' end);
    exception when others then
      insert into probe values ('run_update','BLOCKED: '||SQLERRM);
    end;

    -- Completing without a snapshot must fail on the CHECK, whoever asks.
    -- That constraint is what makes "every completed run can say what it read"
    -- an invariant instead of a convention.
    begin
      update product_recommendation_runs
        set status='completed', completed_at=now(), knowledge_snapshot_id=null
        where id = rid;
      insert into probe values ('complete_without_snapshot','ALLOWED');
    exception when others then
      insert into probe values ('complete_without_snapshot','BLOCKED');
    end;

    begin
      insert into knowledge_snapshots (consumer_type, consumer_run_id, created_by, mode, query_json, data_cutoff, algorithm_version)
      values ('product_recommendation', rid, uid,'stored_only','{}'::jsonb, now(),'rls-probe');
      insert into probe values ('snapshot_insert','ALLOWED');
    exception when others then
      insert into probe values ('snapshot_insert','BLOCKED');
    end;

    begin
      delete from product_recommendation_runs where id = rid;
      get diagnostics n = row_count;
      insert into probe values ('run_delete', case when n = 1 then 'ALLOWED' else 'BLOCKED' end);
    exception when others then
      insert into probe values ('run_delete','BLOCKED');
    end;
  end if;

  perform set_config('role','postgres', true);
  if rid is not null then delete from product_recommendation_runs where id = rid; end if;
end $$;

select step, result from probe;
`;

async function main(): Promise<void> {
	const rows = (await runManagementSql(PROBE)) as Array<{ step: string; result: string }>;
	const byStep = new Map(rows.map((r) => [r.step, r.result]));
	for (const [step, result] of byStep) console.log(`  ${step.padEnd(16)} ${result}`);

	if (byStep.get("profile") === "NONE") {
		console.log("SKIP: no member/admin profile exists to impersonate");
		return;
	}
	assert.ok(
		["member", "admin"].includes(byStep.get("role") ?? ""),
		"the impersonation did not resolve to a member or admin",
	);

	// What the run service must be able to do as the signed-in user.
	assert.equal(byStep.get("run_insert"), "ALLOWED", "a user must be able to start their own run");
	assert.equal(byStep.get("item_insert"), "ALLOWED", "a user must be able to write their run's items");
	assert.equal(byStep.get("run_update"), "ALLOWED", "a user must be able to update their own run");
	assert.equal(
		byStep.get("complete_without_snapshot"),
		"BLOCKED",
		"a run must not be able to reach 'completed' without the snapshot that says what it read",
	);

	// And what it must NOT. This is the contract the service client exists for:
	// if this ever flips to ALLOWED, the intelligence layer's write side has
	// been widened and the reason should be examined, not accepted.
	assert.equal(
		byStep.get("snapshot_insert"),
		"BLOCKED",
		"knowledge_snapshots is service-role-write by design; a user client must not reach it",
	);

	// A run is an audit record of a recommendation someone may have acted on.
	assert.equal(byStep.get("run_delete"), "BLOCKED", "no user may delete a run");
	console.log("✓ writes are permitted exactly where they should be");

	// The service client is used for the snapshot ON PURPOSE. Pinned so a later
	// reader who sees the mixed clients does not "tidy" it back to auth.sb and
	// restore the outage.
	const run = readFileSync("lib/product-finder/run.ts", "utf8");
	assert.ok(
		/createSnapshot:\s*\(draft\)\s*=>\s*createKnowledgeSnapshot\(getServiceClient\(\)/.test(run),
		"the snapshot write must use the service client — a user client is blocked by RLS",
	);
	assert.ok(
		/createRun[\s\S]{0,200}await sb\b/.test(run),
		"the run insert must stay on the user's client so RLS still decides",
	);
	console.log("✓ the snapshot uses the service client and the run does not");

	console.log("PASS: product finder rls");
}

main().catch((error) => {
	console.error("FAIL:", error);
	process.exit(1);
});
