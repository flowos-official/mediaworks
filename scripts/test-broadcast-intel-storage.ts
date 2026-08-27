import assert from "node:assert/strict";
import { isRestoreComplete } from "../lib/broadcast-intel/storage-class";

// THE reason this predicate exists. A restored object keeps its cold storage
// class forever, so classifying on StorageClass alone treats a fully restored
// object as offline. Measured 2026-08-28 on a real archived slot:
//   StorageClass : DEEP_ARCHIVE
//   Restore      : ongoing-request="false", expiry-date="Fri, 11 Sep 2026 00:00:00 GMT"
// The first 家電 drain skipped 22 of 25 slots this way, hours after their
// restore had completed.
const RESTORED = 'ongoing-request="false", expiry-date="Fri, 11 Sep 2026 00:00:00 GMT"';
assert.equal(isRestoreComplete(RESTORED), true, "a completed restore is readable");

// An in-progress restore is NOT readable — Deep Archive takes up to 12h, and
// treating this as available spends a full 1.2 GB request to fail.
assert.equal(isRestoreComplete('ongoing-request="true"'), false);

// No header at all = never restored.
assert.equal(isRestoreComplete(undefined), false);
assert.equal(isRestoreComplete(""), false);

// Tolerate spacing variation in the header S3 returns.
assert.equal(isRestoreComplete('ongoing-request = "false"'), true);

// Must key on the flag, not on the mere presence of the word "false"
// somewhere in the expiry text.
assert.equal(isRestoreComplete('ongoing-request="true", expiry-date="false"'), false);

console.log("PASS: broadcast-intel storage");
