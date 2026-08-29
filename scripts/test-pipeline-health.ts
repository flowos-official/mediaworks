import assert from "node:assert/strict";
import {
	classifyStageHealth,
	isCronDiscoveryRun,
	latestRunProbe,
	parseLatestVercelInvocation,
} from "../lib/cron/pipeline-health";

const HOUR = 3_600_000;
const nowMs = Date.parse("2026-08-29T02:10:00.000Z");

assert.equal(
	isCronDiscoveryRun({ produced_count: 30, category_plan: { categories: [] } }),
	true,
	"a completed cron remains identifiable even if its iteration count changes",
);
assert.equal(
	isCronDiscoveryRun({ produced_count: 0, category_plan: null }),
	true,
	"an early failed cron has no plan but must still be monitored",
);
assert.equal(
	isCronDiscoveryRun({ produced_count: 4, category_plan: null }),
	false,
	"a synthetic strategy discovery run must not mask the cron outcome",
);

// Regression: at the morning check, yesterday's success is only ~24h old.
// The old script therefore exited 0 even when today's scheduled run failed.
const failedLatest = latestRunProbe(
	[
		{ run_at: "2026-08-28T02:05:00.000Z", status: "completed" },
		{ run_at: "2026-08-29T02:05:00.000Z", status: "failed" },
	],
	new Set(["completed", "partial"]),
);
assert.deepEqual(failedLatest, {
	at: "2026-08-28T02:05:00.000Z",
	latestAt: "2026-08-29T02:05:00.000Z",
	latestStatus: "failed",
	healthy: false,
});
assert.equal(
	classifyStageHealth({
		at: failedLatest.at,
		sourceHealthy: failedLatest.healthy,
		maxAgeMs: 26 * HOUR,
		nowMs,
	}),
	"failed",
	"a fresh previous success must not hide the latest failed run",
);

const recoveredLatest = latestRunProbe(
	[
		{ run_at: "2026-08-29T00:05:00.000Z", status: "failed" },
		{ run_at: "2026-08-29T02:05:00.000Z", status: "completed" },
	],
	new Set(["completed", "partial"]),
);
assert.equal(recoveredLatest.healthy, true, "a later success clears an older failure");

// Regression from production on 2026-08-29: files were finalized seconds
// before Vercel killed the route, so video_downloaded_at looked fresh while the
// latest HTTP result was 504. The request outcome is authoritative.
const logs = [
	JSON.stringify({
		timestamp: Date.parse("2026-08-29T00:01:00.000Z"),
		requestPath: "/api/cron/archive-videos",
		responseStatusCode: 200,
		message: "",
	}),
	JSON.stringify({
		timestamp: Date.parse("2026-08-29T02:01:00.000Z"),
		requestPath: "/api/cron/archive-videos",
		responseStatusCode: 504,
		message: "Vercel Runtime Timeout Error: Task timed out after 300 seconds",
	}),
	JSON.stringify({
		timestamp: Date.parse("2026-08-29T02:05:00.000Z"),
		requestPath: "/api/cron/research-stuck-detector",
		responseStatusCode: 200,
		message: "",
	}),
].join("\n");
const archiveInvocation = parseLatestVercelInvocation(
	logs,
	"/api/cron/archive-videos",
);
assert.deepEqual(archiveInvocation, {
	at: "2026-08-29T02:01:00.000Z",
	statusCode: 504,
	message: "Vercel Runtime Timeout Error: Task timed out after 300 seconds",
	healthy: false,
});
assert.equal(
	classifyStageHealth({
		at: archiveInvocation?.at ?? null,
		sourceHealthy: archiveInvocation?.healthy ?? false,
		maxAgeMs: 3 * HOUR,
		nowMs,
	}),
	"failed",
	"a recent 504 must fail even when the database shows fresh archive progress",
);

assert.equal(
	parseLatestVercelInvocation("", "/api/cron/archive-videos"),
	null,
	"missing request logs fail closed at the stage classifier",
);

console.log("PASS: pipeline health");
