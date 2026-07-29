import { buildAnalyzeTriggerHeaders } from "../lib/research/analyze-trigger-headers";
import { hasInternalSecret } from "../lib/auth/require-user";

function assert(condition: boolean, message: string) {
	if (!condition) {
		console.error(`FAIL: ${message}`);
		process.exitCode = 1;
	} else {
		console.log(`PASS: ${message}`);
	}
}

process.env.CRON_SECRET = "unit-secret";

assert(
	hasInternalSecret(
		new Request("http://localhost/api/analyze", {
			headers: { Authorization: "Bearer unit-secret" },
		}),
	),
	"hasInternalSecret accepts the configured bearer token",
);

assert(
	!hasInternalSecret(
		new Request("http://localhost/api/analyze", {
			headers: { Authorization: "Bearer wrong-secret" },
		}),
	),
	"hasInternalSecret rejects the wrong bearer token",
);

assert(
	buildAnalyzeTriggerHeaders("unit-secret").Authorization === "Bearer unit-secret",
	"upload analyze trigger includes Authorization when CRON_SECRET exists",
);

assert(
	!("Authorization" in buildAnalyzeTriggerHeaders(undefined)),
	"upload analyze trigger omits Authorization when CRON_SECRET is missing",
);

if (process.exitCode === 1) process.exit(1);
console.log("PASS: analyze internal auth helpers");
