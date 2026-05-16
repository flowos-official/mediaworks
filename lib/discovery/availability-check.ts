/**
 * Daily availability check + price baseline snapshot.
 *
 *   1. HEAD-request each discovered_product.product_url
 *   2. 200/3xx → mark is_still_available=true, refresh last_seen_at
 *      4xx (esp. 404/410) → mark is_still_available=false
 *      Other (5xx, network) → leave is_still_available unchanged, count as error
 *   3. Insert a daily product_snapshots baseline (price + availability) per row
 *      — UNIQUE(discovered_product_id, snapshot_at) protects against re-runs
 *      within the same hour but we only run once a day.
 */

import { getServiceClient } from "@/lib/supabase";
import { sleep } from "@/lib/broadcasts/fetch";

const HEAD_TIMEOUT_MS = 10_000;

export interface AvailabilityResult {
	checked: number;
	available: number;
	gone: number;
	errors: number;
	snapshots_added: number;
}

export interface AvailabilityOptions {
	limit?: number;
	/** Concurrent in-flight HEAD requests. Default 6 (clamped 1..12). */
	concurrency?: number;
	/** Sleep ms between chunks. Default 200. */
	chunkPauseMs?: number;
	onProgress?: (msg: string) => void;
}

interface DpRow {
	id: string;
	product_url: string;
	price_jpy: number | null;
	stock_status: string | null;
	is_still_available: boolean | null;
}

async function headStatus(url: string): Promise<number | null> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), HEAD_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method: "HEAD",
			signal: ctrl.signal,
			redirect: "follow",
			headers: { "User-Agent": "MediaWorks-AvailabilityCheck/1.0" },
		});
		clearTimeout(timer);
		return res.status;
	} catch {
		clearTimeout(timer);
		return null;
	}
}

export async function checkAvailability(
	opts: AvailabilityOptions = {},
): Promise<AvailabilityResult> {
	const sb = getServiceClient();
	const onProgress = opts.onProgress ?? (() => {});
	const concurrency = Math.max(1, Math.min(opts.concurrency ?? 6, 12));
	const pause = opts.chunkPauseMs ?? 200;

	// Order by stalest (last_seen_at oldest) first.
	const { data, error } = await sb
		.from("discovered_products")
		.select("id, product_url, price_jpy, stock_status, is_still_available")
		.order("last_seen_at", { ascending: true, nullsFirst: true })
		.limit(opts.limit ?? 500);
	if (error) throw new Error(`fetch discovered_products: ${error.message}`);
	const rows = (data ?? []) as DpRow[];

	let available = 0;
	let gone = 0;
	let errors = 0;
	let snapshotsAdded = 0;
	const now = new Date().toISOString();
	// snapshot_at: floor to the day for idempotency (same value → unique conflict)
	const dayBucket = new Date();
	dayBucket.setUTCHours(0, 0, 0, 0);
	const snapshotAt = dayBucket.toISOString();

	for (let i = 0; i < rows.length; i += concurrency) {
		const chunk = rows.slice(i, i + concurrency);
		const probes = await Promise.all(
			chunk.map(async (r) => ({ row: r, status: await headStatus(r.product_url) })),
		);

		const updates: Array<{ id: string; is_still_available: boolean; bumpSeen: boolean }> = [];
		const snapshotInserts: Array<Record<string, unknown>> = [];

		for (const { row, status } of probes) {
			if (status === null) {
				errors++;
				continue;
			}
			const isAvailable = status >= 200 && status < 400;
			const isGone = status === 404 || status === 410;
			if (isAvailable) {
				available++;
				updates.push({ id: row.id, is_still_available: true, bumpSeen: true });
			} else if (isGone) {
				gone++;
				updates.push({ id: row.id, is_still_available: false, bumpSeen: false });
			} else {
				errors++;
			}
			snapshotInserts.push({
				discovered_product_id: row.id,
				snapshot_at: snapshotAt,
				price_jpy: row.price_jpy,
				stock_status: row.stock_status,
				is_available: isAvailable,
			});
		}

		// Batch updates: one query per status group keeps it cheap
		const availIds = updates.filter((u) => u.is_still_available).map((u) => u.id);
		const goneIds = updates.filter((u) => !u.is_still_available).map((u) => u.id);
		if (availIds.length > 0) {
			const { error: e } = await sb
				.from("discovered_products")
				.update({ is_still_available: true, last_seen_at: now })
				.in("id", availIds);
			if (e) onProgress(`update available: ${e.message}`);
		}
		if (goneIds.length > 0) {
			const { error: e } = await sb
				.from("discovered_products")
				.update({ is_still_available: false })
				.in("id", goneIds);
			if (e) onProgress(`update gone: ${e.message}`);
		}
		if (snapshotInserts.length > 0) {
			const { error: e, count } = await sb
				.from("product_snapshots")
				.upsert(snapshotInserts, {
					onConflict: "discovered_product_id,snapshot_at",
					ignoreDuplicates: true,
					count: "exact",
				});
			if (e) onProgress(`snapshot upsert: ${e.message}`);
			else if (count != null) snapshotsAdded += count;
		}

		onProgress(
			`[${Math.min(i + concurrency, rows.length)}/${rows.length}] avail=${available} gone=${gone} err=${errors} snaps=${snapshotsAdded}`,
		);
		if (i + concurrency < rows.length) await sleep(pause);
	}

	return {
		checked: rows.length,
		available,
		gone,
		errors,
		snapshots_added: snapshotsAdded,
	};
}
