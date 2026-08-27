/**
 * Request a Glacier restore for archived broadcast videos that are currently
 * cold, so the analysis drain can read them.
 *
 * Usage:
 *   npm run restore:archives -- --category=家電                 # dry run
 *   npm run restore:archives -- --category=家電 --apply
 *   npm run restore:archives -- --category=家電 --channel=shopch --tier=Bulk --apply
 *
 * Why this exists: a lifecycle rule moved 5,051 of 5,089 archived objects
 * (3.24 TB) to DEEP_ARCHIVE one day after upload. The rule has since been
 * changed to Glacier Instant Retrieval, but that only affects NEW objects —
 * everything already cold stays cold until explicitly restored.
 *
 * Restores are asynchronous: this only places the request. Deep Archive
 * Standard tier completes in ~12 hours, Bulk in ~48. Re-run with --status to
 * see how far along they are. A restored copy stays warm for --days days,
 * then reverts.
 */
import {
  HeadObjectCommand,
  ListObjectsV2Command,
  RestoreObjectCommand,
} from "@aws-sdk/client-s3";
import { getVideoStorageClient } from "@/lib/broadcasts/video-storage";
import { getServiceClient } from "@/lib/supabase";

const COLD = new Set(["GLACIER", "DEEP_ARCHIVE"]);
const CONCURRENCY = 8;

function flag(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

interface Slot {
  id: string;
  channel: string;
  air_date: string;
  archived_video_s3: string;
  video_size_bytes: number | null;
}

async function targets(category: string, channel?: string): Promise<Slot[]> {
  const sb = getServiceClient();
  let q = sb
    .from("broadcasts")
    .select("id, channel, air_date, archived_video_s3, video_size_bytes")
    .eq("category", category)
    .not("archived_video_s3", "is", null)
    .order("air_date", { ascending: false });
  if (channel) q = q.eq("channel", channel);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Slot[];
}

/** Storage class per key, read with ListObjectsV2 (works even without
 *  s3:GetObject, and cheaper than a HeadObject per key). */
async function storageClasses(keys: string[]): Promise<Map<string, string>> {
  const Bucket = process.env.VIDEO_ARCHIVE_AWS_BUCKET!;
  const s3 = getVideoStorageClient();
  const out = new Map<string, string>();
  let token: string | undefined;
  do {
    const r = await s3.send(
      new ListObjectsV2Command({ Bucket, Prefix: "videos/", ContinuationToken: token, MaxKeys: 1000 }),
    );
    for (const o of r.Contents ?? []) {
      if (o.Key) out.set(o.Key, o.StorageClass ?? "STANDARD");
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return new Map(keys.filter((k) => out.has(k)).map((k) => [k, out.get(k)!]));
}

async function pool<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await work(items[i++]);
    }),
  );
}

async function main(): Promise<void> {
  const Bucket = process.env.VIDEO_ARCHIVE_AWS_BUCKET;
  if (!Bucket) throw new Error("Missing required env var: VIDEO_ARCHIVE_AWS_BUCKET");
  const category = flag("category");
  if (!category) throw new Error("--category is required (e.g. --category=家電)");
  const channel = flag("channel");
  const tier = (flag("tier") ?? "Standard") as "Standard" | "Bulk" | "Expedited";
  if (!["Standard", "Bulk", "Expedited"].includes(tier)) throw new Error(`invalid --tier=${tier}`);
  const days = Number(flag("days") ?? 14);
  if (!Number.isInteger(days) || days < 1) throw new Error(`invalid --days=${flag("days")}`);
  const apply = has("apply");
  const s3 = getVideoStorageClient();

  const slots = await targets(category, channel);
  console.log(`${category}${channel ? ` / ${channel}` : ""}: 아카이브 ${slots.length}편`);
  if (slots.length === 0) return;

  const classes = await storageClasses(slots.map((s) => s.archived_video_s3));
  const cold = slots.filter((s) => COLD.has(classes.get(s.archived_video_s3) ?? "STANDARD"));
  const warm = slots.length - cold.length;
  const gb = cold.reduce((t, s) => t + (s.video_size_bytes ?? 0), 0) / 1e9;
  console.log(`  이미 사용 가능: ${warm}편`);
  console.log(`  복원 대상     : ${cold.length}편 / ${gb.toFixed(1)} GB`);

  if (has("status")) {
    console.log("\n복원 상태 확인 중...");
    let done = 0, running = 0, none = 0;
    await pool(cold, CONCURRENCY, async (s) => {
      const h = await s3.send(new HeadObjectCommand({ Bucket, Key: s.archived_video_s3 }));
      const r = h.Restore ?? "";
      if (r.includes('ongoing-request="false"')) done++;
      else if (r.includes('ongoing-request="true"')) running++;
      else none++;
    });
    console.log(`  완료 ${done} / 진행중 ${running} / 미요청 ${none}`);
    return;
  }

  if (!apply) {
    console.log(`\n[dry run] --apply 를 붙이면 위 ${cold.length}편에 복원을 요청합니다.`);
    console.log(`  tier=${tier} (Standard≈12시간 / Bulk≈48시간), 보관 ${days}일`);
    console.log(`  복원 요금은 GB당 + 요청당 과금됩니다. Bulk 가 가장 저렴합니다.`);
    return;
  }

  console.log(`\ntier=${tier}, ${days}일 보관으로 ${cold.length}편 복원 요청 중...`);
  let ok = 0, already = 0, failed = 0;
  await pool(cold, CONCURRENCY, async (s) => {
    try {
      await s3.send(
        new RestoreObjectCommand({
          Bucket,
          Key: s.archived_video_s3,
          RestoreRequest: { Days: days, GlacierJobParameters: { Tier: tier } },
        }),
      );
      ok++;
    } catch (e) {
      const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      if (/RestoreAlreadyInProgress/i.test(m)) already++;
      else {
        failed++;
        console.log(`  실패 ${s.air_date} ${s.archived_video_s3} — ${m.slice(0, 120)}`);
      }
    }
  });

  console.log(`\n요청됨 ${ok} / 이미 진행중 ${already} / 실패 ${failed}`);
  console.log(`복원은 비동기입니다. 진행 상황: npm run restore:archives -- --category=${category}${channel ? ` --channel=${channel}` : ""} --status`);
}

main();
