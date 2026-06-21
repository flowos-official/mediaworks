// DB-free invariant test for navigation ↔ route-permission coherence.
//
// Guards the latent fragility flagged in the 2026-06-19 system review:
// `market.visibility.viewer: 'full'` renders correctly today only because the per-member
// `roles` annotations on broadcasts/discovery/strategy happen to leave exactly one
// viewer-visible member (pipeline). If a `roles` filter is dropped, or a new viewer-visible
// member pointing at a middleware-forbidden route is added, the UI would render a nav link
// that the middleware (proxy.ts) immediately redirects away from — violating the core
// principle "never render an action the current role cannot use."
//
// This test ties nav visibility back to the single source of truth (route-permissions),
// so that drift fails CI instead of silently shipping a misleading link.
//
// Run: npm run test:nav-permissions  (pure logic, no DB / no env needed)

import { NAV_GROUPS, visibleMembersForRole } from "../lib/nav/groups";
import { isViewerAllowedPath } from "../lib/auth/route-permissions";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

let checks = 0;

// Invariant 1: every nav member a viewer can SEE must resolve to a viewer-allowed route.
// Only 'full' visibility renders the (role-filtered) member list. 'productsOnly' renders a
// hardcoded /analytics/products link and 'hidden' renders nothing — both safe by construction,
// so we skip them here.
for (const group of NAV_GROUPS) {
	if (group.visibility.viewer !== "full") continue;
	const members = visibleMembersForRole(group, "viewer");
	assert(
		members.length > 0,
		`group "${group.key}" is 'full' for viewer but has no viewer-visible members (would render an empty/broken group)`,
	);
	for (const member of members) {
		assert(
			isViewerAllowedPath(member.href),
			`viewer can see nav member "${member.href}" (group "${group.key}") but middleware forbids it — ` +
				`add a roles filter to that member or remove it from viewer-visible nav`,
		);
		checks++;
	}
}

// Invariant 2: coarse group gates stay closed where the model requires it.
const admin = NAV_GROUPS.find((g) => g.key === "admin");
const produce = NAV_GROUPS.find((g) => g.key === "produce");
assert(admin, "admin group must exist");
assert(produce, "produce group must exist");
assert(admin.visibility.viewer === "hidden", "admin group must be hidden for viewer");
assert(admin.visibility.member === "hidden", "admin group must be hidden for member");
assert(produce.visibility.viewer === "hidden", "produce group must be hidden for viewer");
checks += 3;

// Invariant 3: viewer must retain at least one reachable nav entry (Products and/or Pipeline).
const viewerHrefs = new Set<string>();
for (const group of NAV_GROUPS) {
	if (group.visibility.viewer === "hidden") continue;
	if (group.visibility.viewer === "productsOnly") {
		viewerHrefs.add("/analytics/products");
		continue;
	}
	for (const member of visibleMembersForRole(group, "viewer")) viewerHrefs.add(member.href);
}
assert(viewerHrefs.size > 0, "viewer must see at least one nav member");
for (const href of viewerHrefs) {
	assert(isViewerAllowedPath(href), `viewer-reachable nav href "${href}" is not in VIEWER_ALLOWED_PATH_PREFIXES`);
}

console.log(
	`✓ nav-permissions invariants hold (${checks} member/gate checks; viewer nav: ${[...viewerHrefs].join(", ")})`,
);
