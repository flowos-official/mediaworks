/**
 * Deadline primitives shared by the archive cron, ffmpeg and S3 upload.
 *
 * NO `import "server-only"` — imported by a tsx regression test.
 */

export interface ArchiveBudgetInput {
	startedAtMs: number;
	nowMs: number;
	budgetMs: number;
	slotBudgetMs: number;
}

/** Start only when a whole slot can still fit inside the route budget. */
export function canStartArchiveBatch(input: ArchiveBudgetInput): boolean {
	return input.nowMs - input.startedAtMs + input.slotBudgetMs <= input.budgetMs;
}

export interface ArchiveDeadline {
	signal: AbortSignal;
	dispose: () => void;
}

/** Abort at an absolute Date.now()-scale deadline. */
export function createArchiveDeadline(
	deadlineMs: number,
	reason = "archive deadline exceeded",
): ArchiveDeadline {
	const controller = new AbortController();
	const abort = () => controller.abort(new Error(reason));
	const remainingMs = deadlineMs - Date.now();
	let timer: ReturnType<typeof setTimeout> | undefined;

	if (remainingMs <= 0) abort();
	else timer = setTimeout(abort, remainingMs);

	return {
		signal: controller.signal,
		dispose: () => {
			if (timer) clearTimeout(timer);
		},
	};
}

interface KillableProcess {
	kill(signal?: NodeJS.Signals | number): boolean;
}

/** Kill ffmpeg when the shared archive deadline fires. */
export function killProcessOnAbort(
	signal: AbortSignal,
	process: KillableProcess,
): () => void {
	const kill = () => {
		process.kill("SIGKILL");
	};
	if (signal.aborted) kill();
	else signal.addEventListener("abort", kill, { once: true });
	return () => signal.removeEventListener("abort", kill);
}

export interface ManagedUpload<T = unknown> {
	done(): Promise<T>;
	abort(): Promise<void>;
}

/** Await a multipart upload and abort it when the shared deadline fires. */
export async function completeManagedUpload<T>(
	upload: ManagedUpload<T>,
	signal?: AbortSignal,
): Promise<T> {
	if (!signal) return upload.done();

	let abortPromise: Promise<void> | undefined;
	const abort = () => {
		if (abortPromise) return;
		try {
			abortPromise = Promise.resolve(upload.abort()).catch(() => undefined);
		} catch {
			abortPromise = Promise.resolve();
		}
	};
	if (signal.aborted) abort();
	else signal.addEventListener("abort", abort, { once: true });

	try {
		return await upload.done();
	} catch (error) {
		// A multipart failure can reject done() before peer cancellation reaches
		// this listener. Explicitly cross and await the public abort boundary too.
		abort();
		throw error;
	} finally {
		signal.removeEventListener("abort", abort);
		// @aws-sdk/lib-storage does not expose completion of its internal
		// AbortMultipartUpload command. Await the public abort boundary so we do
		// not roll the DB row back while the caller's cleanup is still running.
		if (abortPromise) await abortPromise;
	}
}

export interface ArchiveTransferTasks<TUpload, TFfmpeg> {
	upload: Promise<TUpload>;
	ffmpeg: Promise<TFfmpeg>;
}

/**
 * Run both transfer halves as one lifecycle. A failure or parent abort cancels
 * the peer, then both promises are settled before the error reaches DB cleanup.
 */
export async function runArchiveTransfer<TUpload, TFfmpeg>(
	parentSignal: AbortSignal | undefined,
	start: (signal: AbortSignal) => ArchiveTransferTasks<TUpload, TFfmpeg>,
): Promise<[TUpload, TFfmpeg]> {
	parentSignal?.throwIfAborted();
	const controller = new AbortController();
	const abortFromParent = () => {
		if (!controller.signal.aborted) {
			controller.abort(parentSignal?.reason ?? new Error("archive transfer aborted"));
		}
	};
	parentSignal?.addEventListener("abort", abortFromParent, { once: true });

	try {
		const tasks = start(controller.signal);
		const cancelPeerOnFailure = async <T>(promise: Promise<T>): Promise<T> => {
			try {
				return await promise;
			} catch (error) {
				if (!controller.signal.aborted) controller.abort(error);
				throw error;
			}
		};
		const upload = cancelPeerOnFailure(tasks.upload);
		const ffmpeg = cancelPeerOnFailure(tasks.ffmpeg);
		try {
			const result = await Promise.all([upload, ffmpeg]);
			// Some cleanup-aware tasks resolve after cancellation. The parent
			// deadline is still a failed transfer, never a successful archive.
			controller.signal.throwIfAborted();
			return result;
		} catch (error) {
			if (!controller.signal.aborted) controller.abort(error);
			await Promise.allSettled([upload, ffmpeg]);
			throw error;
		}
	} finally {
		parentSignal?.removeEventListener("abort", abortFromParent);
	}
}
