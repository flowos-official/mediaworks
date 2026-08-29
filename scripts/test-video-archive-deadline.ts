import assert from "node:assert/strict";
import {
	canStartArchiveBatch,
	completeManagedUpload,
	createArchiveDeadline,
	killProcessOnAbort,
	runArchiveTransfer,
} from "../lib/broadcasts/archive-deadline";

async function main(): Promise<void> {
	// Regression: the old route started another batch at t=239s because it only
	// checked whether the 240s budget had already elapsed. That batch then ran
	// until Vercel killed the function at 300s.
	assert.equal(
		canStartArchiveBatch({
			startedAtMs: 0,
			nowMs: 39_999,
			budgetMs: 240_000,
			slotBudgetMs: 200_000,
		}),
		true,
		"a full slot still fits just before the start boundary",
	);
	assert.equal(
		canStartArchiveBatch({
			startedAtMs: 0,
			nowMs: 40_001,
			budgetMs: 240_000,
			slotBudgetMs: 200_000,
		}),
		false,
		"do not start a batch that cannot finish inside the route budget",
	);

	// The deadline must be active, not merely a value checked between batches.
	// A hung ffmpeg/S3 operation has to receive an abort while it is in flight.
	const deadline = createArchiveDeadline(Date.now() + 20);
	await new Promise<void>((resolve, reject) => {
		deadline.signal.addEventListener("abort", () => resolve(), { once: true });
		setTimeout(() => reject(new Error("deadline signal did not abort")), 500);
	});
	assert.equal(deadline.signal.aborted, true);
	assert.match(String(deadline.signal.reason), /archive deadline exceeded/i);
	deadline.dispose();

	// ffmpeg must be terminated by the same signal.
	let killedWith: string | undefined;
	const processController = new AbortController();
	const unbindProcess = killProcessOnAbort(processController.signal, {
		kill(signal?: NodeJS.Signals | number) {
			killedWith = String(signal);
			return true;
		},
	});
	processController.abort(new Error("deadline"));
	assert.equal(killedWith, "SIGKILL");
	unbindProcess();

	// The S3 multipart upload must be aborted too; otherwise parts continue after
	// the route returns and the process still owns live work.
	const uploadController = new AbortController();
	let uploadAborted = false;
	let rejectUpload!: (reason?: unknown) => void;
	const uploadDone = new Promise<never>((_resolve, reject) => {
		rejectUpload = reject;
	});
	const uploadPromise = completeManagedUpload(
		{
			done: () => uploadDone,
			abort: async () => {
				uploadAborted = true;
				rejectUpload(new Error("upload aborted"));
			},
		},
		uploadController.signal,
	);
	uploadController.abort(new Error("deadline"));
	await assert.rejects(uploadPromise, /upload aborted/);
	assert.equal(uploadAborted, true);

	// Returning from done() is not enough: wait for the public abort operation
	// too, so cleanup has at least reached the SDK boundary before DB rollback.
	const cleanupController = new AbortController();
	let cleanupFinished = false;
	let rejectDone!: (reason?: unknown) => void;
	const cleanupPromise = completeManagedUpload(
		{
			done: () => new Promise<never>((_resolve, reject) => {
				rejectDone = reject;
			}),
			abort: async () => {
				rejectDone(new Error("done aborted before cleanup"));
				await new Promise((resolve) => setTimeout(resolve, 20));
				cleanupFinished = true;
			},
		},
		cleanupController.signal,
	);
	cleanupController.abort(new Error("deadline"));
	await assert.rejects(cleanupPromise, /done aborted before cleanup/);
	assert.equal(cleanupFinished, true, "managed upload waits for abort cleanup");

	// Whichever transfer side fails first must cancel its peer and wait for that
	// peer to close. Promise.all alone returned as soon as the first side failed.
	let ffmpegClosed = false;
	await assert.rejects(
		runArchiveTransfer(undefined, (signal) => ({
			upload: Promise.reject(new Error("s3 failed")),
			ffmpeg: new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => {
					setTimeout(() => {
						ffmpegClosed = true;
						resolve();
					}, 20);
				}, { once: true });
			}),
		})),
		/s3 failed/,
	);
	assert.equal(ffmpegClosed, true, "upload failure waits for ffmpeg close");

	let rejectedUploadAborted = false;
	let rejectedUploadCleanupFinished = false;
	let rejectedUploadPeerClosed = false;
	await assert.rejects(
		runArchiveTransfer(undefined, (signal) => ({
			upload: completeManagedUpload(
				{
					done: () => Promise.reject(new Error("multipart failed first")),
					abort: async () => {
						rejectedUploadAborted = true;
						await new Promise((resolve) => setTimeout(resolve, 20));
						rejectedUploadCleanupFinished = true;
					},
				},
				signal,
			),
			ffmpeg: new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => {
					rejectedUploadPeerClosed = true;
					resolve();
				}, { once: true });
			}),
		})),
		/multipart failed first/,
	);
	assert.equal(rejectedUploadAborted, true, "upload-originated failure invokes public abort");
	assert.equal(rejectedUploadCleanupFinished, true, "upload-originated failure awaits public abort");
	assert.equal(rejectedUploadPeerClosed, true, "upload-originated failure still closes ffmpeg");

	let uploadCleaned = false;
	await assert.rejects(
		runArchiveTransfer(undefined, (signal) => ({
			upload: new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => {
					setTimeout(() => {
						uploadCleaned = true;
						resolve();
					}, 20);
				}, { once: true });
			}),
			ffmpeg: Promise.reject(new Error("ffmpeg failed")),
		})),
		/ffmpeg failed/,
	);
	assert.equal(uploadCleaned, true, "ffmpeg failure waits for upload cleanup");

	const parentController = new AbortController();
	const parentAbort = runArchiveTransfer(parentController.signal, (signal) => {
		const settleOnAbort = () => new Promise<void>((resolve) => {
			signal.addEventListener("abort", () => resolve(), { once: true });
		});
		return { upload: settleOnAbort(), ffmpeg: settleOnAbort() };
	});
	parentController.abort(new Error("parent archive deadline"));
	await assert.rejects(
		parentAbort,
		/parent archive deadline/,
		"a parent deadline cannot become a successful transfer merely because cleanup resolved",
	);

	console.log("PASS: video archive deadline");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
