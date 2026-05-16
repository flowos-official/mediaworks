/**
 * Simulate the feedback API's toggle-off behavior with two different users
 * to demonstrate whether multi-user feedback is recorded correctly.
 *
 * Replicates the route logic locally (service role) — no live HTTP needed.
 */
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Action = 'sourced' | 'interested' | 'rejected' | 'duplicate';

interface SimResult {
  step: string;
  user_action: string | null;
  feedbacks: Array<{ user_id: string | null; action: string; created_at: string }>;
}

async function snapshot(productId: string, step: string): Promise<SimResult> {
  const { data: product } = await sb
    .from('discovered_products').select('user_action').eq('id', productId).single();
  const { data: fb } = await sb
    .from('product_feedback')
    .select('user_id, action, created_at')
    .eq('discovered_product_id', productId)
    .order('created_at', { ascending: true });
  return { step, user_action: product?.user_action ?? null, feedbacks: fb ?? [] };
}

/** Replicate the (fixed) /api/discovery/feedback POST logic. */
async function simulateFeedback(productId: string, userId: string, action: Action) {
  const { data: product } = await sb
    .from('discovered_products')
    .select('id')
    .eq('id', productId)
    .maybeSingle();
  if (!product) throw new Error('product not found');

  const { data: myLast } = await sb
    .from('product_feedback')
    .select('action, created_at')
    .eq('discovered_product_id', productId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const isOwnToggleOff = myLast?.action === action;
  const now = new Date().toISOString();

  if (isOwnToggleOff) {
    await sb.from('product_feedback').delete()
      .eq('discovered_product_id', productId)
      .eq('user_id', userId)
      .eq('action', action);
    const { data: lastByAnyone } = await sb
      .from('product_feedback')
      .select('action, reason, created_at')
      .eq('discovered_product_id', productId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    await sb.from('discovered_products').update({
      user_action: lastByAnyone?.action ?? null,
      action_reason: lastByAnyone?.reason ?? null,
      action_at: lastByAnyone?.created_at ?? null,
    }).eq('id', productId);
    return;
  }

  await Promise.all([
    sb.from('product_feedback').insert({
      discovered_product_id: productId,
      action,
      reason: null,
      user_id: userId,
    }),
    sb.from('discovered_products')
      .update({ user_action: action, action_reason: null, action_at: now })
      .eq('id', productId),
  ]);
}

async function main() {
  // 1) Get user ids for jp and kj
  const { data: users } = await sb
    .from('profiles')
    .select('id, email, role')
    .in('email', ['jp@flowos.work', 'kj@flowos.work']);
  if (!users || users.length < 2) {
    console.error('need both jp and kj profiles; found:', users);
    process.exit(1);
  }
  const jp = users.find((u) => u.email === 'jp@flowos.work')!;
  const kj = users.find((u) => u.email === 'kj@flowos.work')!;
  console.log(`jp=${jp.id.slice(0, 8)}, kj=${kj.id.slice(0, 8)}`);

  // 2) Pick a sandbox product. Find one with no current user_action and no
  //    existing feedback so we have a clean slate.
  const { data: candidates } = await sb
    .from('discovered_products')
    .select('id, name, user_action')
    .is('user_action', null)
    .limit(20);
  if (!candidates || candidates.length === 0) {
    console.error('no candidate product found');
    process.exit(1);
  }
  // Pick one with NO existing feedback to avoid pollution
  let testProductId: string | null = null;
  for (const c of candidates) {
    const { count } = await sb
      .from('product_feedback')
      .select('*', { count: 'exact', head: true })
      .eq('discovered_product_id', c.id);
    if (count === 0) {
      testProductId = c.id;
      break;
    }
  }
  if (!testProductId) {
    console.error('no clean candidate (without existing feedback)');
    process.exit(1);
  }
  console.log(`Using sandbox product: ${testProductId}\n`);

  // 3) Run scenarios
  const trail: SimResult[] = [];
  trail.push(await snapshot(testProductId, 'initial'));

  console.log("== Scenario A: jp sources, kj also sources, kj toggles off ==");
  await simulateFeedback(testProductId, jp.id, 'sourced');
  trail.push(await snapshot(testProductId, "(A) after jp 'sourced'"));

  await simulateFeedback(testProductId, kj.id, 'sourced');
  trail.push(await snapshot(testProductId, "(A) after kj 'sourced' (multi-user affirm)"));

  await simulateFeedback(testProductId, kj.id, 'sourced'); // kj toggles off
  trail.push(await snapshot(testProductId, "(A) after kj 'sourced' again (own toggle off)"));

  await simulateFeedback(testProductId, jp.id, 'interested'); // jp changes mind
  trail.push(await snapshot(testProductId, "(A) after jp switches to 'interested'"));

  // 4) Print
  for (const t of trail) {
    console.log(`\n[${t.step}]`);
    console.log('  discovered_products.user_action =', t.user_action);
    console.log('  product_feedback rows:');
    if (t.feedbacks.length === 0) {
      console.log('    (none)');
    } else {
      for (const r of t.feedbacks) {
        const tag = r.user_id === jp.id ? 'jp' : r.user_id === kj.id ? 'kj' : 'other';
        console.log(`    - ${tag.padEnd(6)} ${r.action.padEnd(10)} ${r.created_at}`);
      }
    }
  }

  // 5) Verdict — check intermediate state after the multi-user affirm
  console.log('\n== Verdict ==');
  const afterMultiUserAffirm = trail[2];
  const jpRecorded = afterMultiUserAffirm.feedbacks.some((f) => f.user_id === jp.id);
  const kjRecorded = afterMultiUserAffirm.feedbacks.some((f) => f.user_id === kj.id);
  console.log(`After both jp + kj sourced:`);
  console.log(`  jp's action recorded: ${jpRecorded ? '✓' : '✗'}`);
  console.log(`  kj's action recorded: ${kjRecorded ? '✓ (multi-user works)' : '✗ BUG'}`);

  const afterKjToggle = trail[3];
  const kjStillRecorded = afterKjToggle.feedbacks.some((f) => f.user_id === kj.id && f.action === 'sourced');
  console.log(`After kj toggles off own mark:`);
  console.log(`  kj's row removed: ${kjStillRecorded ? '✗ (still there)' : '✓'}`);
  console.log(`  team state fell back to jp's: ${afterKjToggle.user_action === 'sourced' ? '✓' : '✗ (got ' + afterKjToggle.user_action + ')'}`);

  const afterJpSwitch = trail[4];
  console.log(`After jp switches to interested:`);
  console.log(`  team state = interested: ${afterJpSwitch.user_action === 'interested' ? '✓' : '✗ (got ' + afterJpSwitch.user_action + ')'}`);
  const jpRows = afterJpSwitch.feedbacks.filter((f) => f.user_id === jp.id);
  console.log(`  jp's feedback row count: ${jpRows.length} (expected 2: sourced + interested)`);

  // 6) Cleanup test data
  console.log('\nCleaning up sandbox product feedback rows...');
  await sb.from('product_feedback').delete().eq('discovered_product_id', testProductId);
  await sb.from('discovered_products')
    .update({ user_action: null, action_reason: null, action_at: null })
    .eq('id', testProductId);
  console.log('done.');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
