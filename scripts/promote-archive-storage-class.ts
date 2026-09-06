/**
 * Promote already-cold archive objects out of DEEP_ARCHIVE into Glacier
 * Instant Retrieval, so they are readable without a restore.
 *
 * Usage:
 *   npm run promote:archives -- --status                  # what is where, and what it would cost
 *   npm run promote:archives -- --channel=qvc             # dry run, one channel
 *   npm run promote:archives -- --channel=qvc --apply
 *   npm run promote:archives -- --apply                   # whole bucket
 *
 * WHY THIS EXISTS
 *
 * The lifecycle rule that buried the archive was fixed on 2026-08-25 — objects
 * uploaded since then land in GLACIER_IR and are readable at any time. It only
 * applies going forward, so everything uploaded before that is still
 * DEEP_ARCHIVE and readable ONLY while a temporary restore copy is alive.
 *
 * That is the state today: the whole back catalogue is readable because a
 * 14-day restore was requested around 2026-08-28. When it lapses, video
 * playback in the UI starts failing — a cold object still answers a CloudFront
 * HEAD with full metadata, so nothing looks broken until the GET returns
 * AccessDenied — and the analysis drain has nothing to read.
 *
 * A restore does not move an object. `CopyObject` onto its own key does, and
 * that is all this script is.
 *
 * TIMING — THIS IS ONLY POSSIBLE WHILE THE RESTORE IS ALIVE
 *
 * Copying FROM a Deep Archive object requires an active restore copy. Once the
 * restore lapses this script cannot run either, and the sequence becomes: Bulk
 * restore (~48h, paid again) -> promote. Check `--status` for the earliest
 * expiry before planning.
 *
 * COSTS
 *
 * Deep Archive bills a 180-day minimum per object. Overwriting one before that
 * is charged for the remaining days, which `--status` totals. Against that,
 * GLACIER_IR is ~$0.005/GB-month versus ~$0.002 for Deep Archive, and carries
 * its own 90-day minimum. No data leaves the region: `CopyObject` is
 * server-side, so this costs nothing in transfer and can be run from anywhere.
 *
 * ORDER OF OPERATIONS — read this before running
 *
 * Reading a live restore copy is free; reading GLACIER_IR costs ~$0.03/GB. So
 * if an analysis drain is also planned, DRAIN FIRST and promote after: doing it
 * the other way round pays retrieval on every byte the drain reads.
 *
 * NO `import "server-only"` — a tsx script.
 */
import {
	CopyObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	type _Object,
} from "@aws-sdk/client-s3";
import { getVideoStorageClient } from "@/lib/broadcasts/video-storage";

/** Classes that cannot serve a GET without a restore. GLACIER_IR is absent on
 *  purpose — it is instantly retrievable, which is the point of moving there. */
const COLD = new Set(["GLACIER", "DEEP_ARCHIVE"]);

const TARGET_CLASS = "GLACIER_IR";
const CONCURRENCY = 12;

/** Approximate ap-northeast-2 list prices, for the estimate `--status` prints.
 *  Confirm against the actual bill before committing to the spend. */
const PRICE_GB_MONTH: Record<string, number> = {
	DEEP_ARCHIVE: 0.002,
	GLACIER_IR: 0.005,
	STANDARD_IA: 0.0138,
	STANDARD: 0.025,
};
const DEEP_ARCHIVE_MIN_DAYS = 180;

function flag(name: string): string | undefined {
	return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

interface ArchiveObject {
	key: string;
	sizeBytes: number;
	storageClass: string;
	lastModified: number;
}

async function listArchive(prefix: string): Promise<ArchiveObject[]> {
	const s3 = getVideoStorageClient();
	const Bucket = requireBucket();
	const out: ArchiveObject[] = [];
	let token: string | undefined;
	do {
		const page = await s3.send(
			new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }),
		);
		for (const o of (page.Contents ?? []) as _Object[]) {
			if (!o.Key) continue;
			out.push({
				key: o.Key,
				sizeBytes: Number(o.Size ?? 0),
				storageClass: String(o.StorageClass ?? "STANDARD"),
				lastModified: new Date(String(o.LastModified)).getTime(),
			});
		}
		token = page.IsTruncated ? page.NextContinuationToken : undefined;
	} while (token);
	return out;
}

function requireBucket(): string {
	const b = process.env.VIDEO_ARCHIVE_AWS_BUCKET;
	if (!b) throw new Error("Missing required env var: VIDEO_ARCHIVE_AWS_BUCKET");
	return b;
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(size, items.length) }, async () => {
			while (i < items.length) {
				const item = items[i++];
				await fn(item);
			}
		}),
	);
}

/** Remaining days of the Deep Archive 180-day minimum, which an overwrite bills. */
function earlyDeletionUsd(objects: ArchiveObject[], now: number): number {
	const perGbDay = PRICE_GB_MONTH.DEEP_ARCHIVE / 30;
	let total = 0;
	for (const o of objects) {
		const ageDays = (now - o.lastModified) / 864e5;
		const remaining = Math.max(0, DEEP_ARCHIVE_MIN_DAYS - ageDays);
		total += (o.sizeBytes / 1e9) * perGbDay * remaining;
	}
	return total;
}

/**
 * The earliest restore expiry across a sample. Copying is impossible after this
 * without restoring again, so it is the deadline the whole operation runs
 * against. Sampled rather than exhaustive: HeadObject on every object costs a
 * request each and the answer only needs to be right to the day.
 */
async function earliestRestoreExpiry(objects: ArchiveObject[]): Promise<{ earliest: Date | null; unrestored: number; sampled: number }> {
	const s3 = getVideoStorageClient();
	const Bucket = requireBucket();
	const step = Math.max(1, Math.floor(objects.length / 60));
	const sample = objects.filter((_, i) => i % step === 0).slice(0, 60);
	let earliest: number | null = null;
	let unrestored = 0;
	await pool(sample, CONCURRENCY, async (o) => {
		try {
			const head = await s3.send(new HeadObjectCommand({ Bucket, Key: o.key }));
			const restore = head.Restore ?? "";
			if (!restore.includes('ongoing-request="false"')) {
				unrestored++;
				return;
			}
			const m = /expiry-date="([^"]+)"/.exec(restore);
			if (!m) return;
			const t = new Date(m[1]).getTime();
			if (Number.isNaN(t)) return;
			if (earliest === null || t < earliest) earliest = t;
		} catch {
			unrestored++;
		}
	});
	return { earliest: earliest === null ? null : new Date(earliest), unrestored, sampled: sample.length };
}

async function main(): Promise<void> {
	requireBucket();
	const channel = flag("channel");
	if (channel && channel !== "qvc" && channel !== "shopch") {
		throw new Error(`--channel must be qvc or shopch, got "${channel}"`);
	}
	const prefix = channel ? `videos/${channel}/` : "videos/";
	const apply = has("apply");
	// The identity that runs this could not read the bucket lifecycle config, so
	// its grants are narrow and CopyObject-with-a-storage-class may not be among
	// them. `--limit` exists so that is discovered on one object rather than on
	// five thousand, halfway through, against a deadline.
	const limitRaw = flag("limit");
	let limit: number | undefined;
	if (limitRaw !== undefined) {
		const n = Number(limitRaw);
		if (!Number.isInteger(n) || n <= 0) throw new Error(`--limit must be a positive integer, got ${JSON.stringify(limitRaw)}`);
		limit = n;
	}
	const now = Date.now();

	const all = await listArchive(prefix);
	const coldAll = all.filter((o) => COLD.has(o.storageClass));
	const cold = limit === undefined ? coldAll : coldAll.slice(0, limit);
	const already = all.filter((o) => o.storageClass === TARGET_CLASS);
	const standard = all.filter((o) => o.storageClass === "STANDARD");

	const gb = (objs: ArchiveObject[]) => objs.reduce((t, o) => t + o.sizeBytes, 0) / 1e9;
	console.log(`${prefix}: ${all.length}편 / ${(gb(all) / 1000).toFixed(2)} TB`);
	console.log(`  DEEP_ARCHIVE (승격 대상): ${coldAll.length}편 / ${gb(coldAll).toFixed(0)} GB`);
	if (limit !== undefined) console.log(`  --limit=${limit} -> 이번 실행 대상 ${cold.length}편 / ${gb(cold).toFixed(0)} GB`);
	console.log(`  ${TARGET_CLASS} (완료)     : ${already.length}편 / ${gb(already).toFixed(0)} GB`);
	console.log(`  STANDARD (전환 대기)     : ${standard.length}편 / ${gb(standard).toFixed(0)} GB`);

	if (cold.length === 0) {
		console.log("\n승격할 객체가 없습니다.");
		return;
	}

	if (has("status")) {
		const { earliest, unrestored, sampled } = await earliestRestoreExpiry(cold);
		console.log(`\n복원 상태 (${sampled}편 표본):`);
		if (earliest) {
			const hours = (earliest.getTime() - now) / 36e5;
			console.log(`  가장 이른 만료: ${earliest.toISOString().slice(0, 16)}  (${hours.toFixed(0)}시간 남음)`);
		} else {
			console.log("  복원된 객체를 찾지 못했습니다 — 먼저 restore:archives 가 필요합니다.");
		}
		if (unrestored > 0) console.log(`  미복원/조회실패: ${unrestored}/${sampled}편`);

		const early = earlyDeletionUsd(cold, now);
		const monthlyNow = gb(cold) * PRICE_GB_MONTH.DEEP_ARCHIVE;
		const monthlyAfter = gb(cold) * PRICE_GB_MONTH[TARGET_CLASS];
		console.log("\n비용 추정 (서울 리전 정가 기준, 실제 청구서로 대조 필요):");
		console.log(`  1회성 조기 삭제 요금 : $${early.toFixed(0)}  (Deep Archive 180일 최소 보관)`);
		console.log(`  월 보관비 ${monthlyNow.toFixed(0)} -> ${monthlyAfter.toFixed(0)} USD  (차액 +$${(monthlyAfter - monthlyNow).toFixed(0)}/월)`);
		console.log(`  전송비 $0 — CopyObject 는 서버 사이드입니다.`);
		console.log(`\n승격 후 분석 드레인은 GB당 $0.03 의 검색비가 붙습니다.`);
		console.log(`드레인 예정이라면 드레인을 먼저 돌리세요 — 살아 있는 복원본 읽기는 무료입니다.`);
		return;
	}

	if (!apply) {
		const early = earlyDeletionUsd(cold, now);
		console.log(`\n[dry run] --apply 를 붙이면 위 ${cold.length}편을 ${TARGET_CLASS} 로 덮어씁니다.`);
		console.log(`  1회성 조기 삭제 요금 추정 $${early.toFixed(0)}, 전송비 없음.`);
		console.log(`  먼저 --status 로 복원 만료까지 남은 시간을 확인하세요.`);
		return;
	}

	console.log(`\n${cold.length}편을 ${TARGET_CLASS} 로 승격 중...`);
	const s3 = getVideoStorageClient();
	const Bucket = requireBucket();
	let ok = 0;
	let failed = 0;
	const failures: string[] = [];
	await pool(cold, CONCURRENCY, async (o) => {
		try {
			// Same key, same bytes; only the storage class changes.
			// MetadataDirective COPY keeps ContentType, which playback needs.
			await s3.send(
				new CopyObjectCommand({
					Bucket,
					Key: o.key,
					CopySource: `${Bucket}/${encodeURIComponent(o.key).replace(/%2F/g, "/")}`,
					StorageClass: TARGET_CLASS,
					MetadataDirective: "COPY",
				}),
			);
			ok++;
			if (ok % 250 === 0) console.log(`  ...${ok}/${cold.length}`);
		} catch (e) {
			failed++;
			const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
			// InvalidObjectState means the restore lapsed (or never landed) for
			// this key. That is the deadline being missed, not a transient fault,
			// so it is worth seeing rather than counting.
			if (failures.length < 10) failures.push(`${o.key} — ${m.slice(0, 140)}`);
		}
	});

	console.log(`\n승격 완료 ${ok} / 실패 ${failed}`);
	for (const f of failures) console.log(`  ${f}`);
	if (failed > 0) {
		console.log("\n실패분은 재실행하면 다시 시도합니다 (이미 승격된 객체는 대상에서 제외됩니다).");
		process.exitCode = 1;
	}
}

main();
