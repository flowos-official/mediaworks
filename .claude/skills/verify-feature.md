---
name: verify-feature
description: Self-verification protocol for mediaworks. Run after completing any feature, endpoint, or UI change — before calling the user back. SF 2026 "Eyes + Hands + Foundations" + "Stop babysitting your agents" pattern.
---

# Verify Feature (mediaworks)

Use after a feature/endpoint/UI change is complete, or when the user says "확인 좀 해줘" / "테스트해봐", or right before a commit.

## Steps (adapt to the change — these are directions, not a rigid script)

### 1. Environment ready
- Dev server: `npm run dev` (port 3000). Reuse if already running.
- `.env.local` keys present for any new external service.
- Supabase migrations applied (`supabase migration list`).

### 2. Static checks
- `npx tsc --noEmit` — must pass. This is a global project rule (per ~/.claude/CLAUDE.md).
- `npm run lint` — must pass.
- For changes touching specific subsystems, run the matching script:
  - Broadcasts parsers → `npm run test:broadcasts-parsers`
  - Strategy pool / discovery union → `npm run test:strategy-pool`
  - Strategy fresh-search persistence → `npm run test:strategy-fresh-search`
  - Pipeline state machine → `npm run test:selections`
  - Live broadcast scrape sanity → `npm run verify:broadcasts`

### 3. Visual verification (UI changes only — use **chrome-devtools MCP**)
Per user preference, use chrome-devtools MCP — not Playwright, not WebFetch — for browser work.
- `mcp__plugin_chrome-devtools-mcp_chrome-devtools__new_page` → navigate to the changed page (`http://localhost:3000/<locale>/...`).
- Run the golden path: e.g., login → core action → result. Use both `ja` and `ko` locales if i18n strings were touched.
- Run 3 edge cases relevant to the change:
  - Empty input / no data state
  - Viewer role (allowed paths in `lib/auth/route-permissions.ts::VIEWER_ALLOWED_PATH_PREFIXES`) vs member/admin
  - Expired session / unauthenticated redirect
- `list_console_messages` → zero errors.
- `list_network_requests` → zero 5xx, no leaked service-role calls from the browser.
- `take_screenshot` → save under repo root for PR attachment if useful.

### 4. Data plane checks (DB writes only)
- Use `getServerClient()` from a test script to read back affected rows — confirms RLS works for the target role.
- For multi-row changes, verify atomicity (either everything landed or nothing — Supabase doesn't auto-transact across multiple calls; check for partial writes).
- For pipeline / selection changes, confirm the partial unique `(discovered_product_id) WHERE status != 'closed'` still holds.
- For discovery changes, confirm `discovered_products` does not contain duplicate URLs in the same `discovery_runs` session.

### 5. Log inspection
- Dev server log: zero unhandled rejections, zero ERROR.
- Spot-check Supabase Studio → Logs for any `permission denied` (RLS bypass smell).

## Failure handling
If any step fails:
1. Capture the error message + stack trace.
2. **Root-cause analysis**, not symptom patching (per global CLAUDE.md).
3. Fix, then restart from step 2.
4. After 3 failed attempts on the same root cause, stop and report to the user with the hypotheses you tried.

## Self-improvement
When you discover a new failure mode, append a one-liner to the Steps above. Stay short — direction over prescription.

## Output format

```
## Verification result: [PASS / FAIL]

### Passed
- typecheck
- npm run test:<scope> (12/12)
- golden path screenshot: <path>
- DB consistency (no partial writes)
- no console errors

### Failed (if any)
- [specific]

### Edge cases verified
- empty input: 400 with friendly message OK
- viewer role: redirected to /analytics/products OK
- expired session: redirected to /login OK

### Next step
- ready for review
- OR: [what still needs fixing]
```

## Hard rules
- Never report PASS for a step you skipped. List skipped steps explicitly.
- "Probably works" is not a verification result. Run the command, observe the output.
- For UI changes you cannot test in the browser, **say so explicitly** — don't claim success (per global CLAUDE.md).
