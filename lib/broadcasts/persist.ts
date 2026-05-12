import { getServiceClient } from "@/lib/supabase";
import type { PersistResult, ScrapedSlot } from "./types";

const CHUNK_SIZE = 100;

/**
 * Inserted/updated 정확 카운트:
 * - 한 청크 내 슬롯들의 (channel, air_date, start_time) 조합으로 PostgREST `or` 필터를 빌드해
 *   기존 행을 조회 → 매칭되는 키 집합 → upsert 결과를 inserted/updated로 분류.
 * - upsert는 항상 멱등(`onConflict`).
 */
export async function upsertBroadcasts(slots: ScrapedSlot[]): Promise<PersistResult> {
	if (slots.length === 0) {
		return { inserted: 0, updated: 0, errors: [] };
	}

	const sb = getServiceClient();
	const errors: PersistResult["errors"] = [];
	let inserted = 0;
	let updated = 0;

	for (let i = 0; i < slots.length; i += CHUNK_SIZE) {
		const chunk = slots.slice(i, i + CHUNK_SIZE);

		// 청크의 키 조합으로 정확한 기존행 조회 — PostgREST `or` 필터
		const orFilter = chunk
			.map(
				(s) =>
					`and(channel.eq.${s.channel},air_date.eq.${s.air_date},start_time.eq.${s.start_time})`,
			)
			.join(",");

		const { data: existing, error: selectError } = await sb
			.from("broadcasts")
			.select("channel,air_date,start_time")
			.or(orFilter);

		if (selectError) {
			console.warn(
				`upsertBroadcasts: existing-row lookup failed (${selectError.message}); inserted/updated counts may be imprecise.`,
			);
		}

		const existingSet = new Set(
			(existing ?? []).map(
				(e: { channel: string; air_date: string; start_time: string }) =>
					`${e.channel}|${e.air_date}|${e.start_time}`,
			),
		);

		const { error: upsertError } = await sb
			.from("broadcasts")
			.upsert(chunk, { onConflict: "channel,air_date,start_time" });

		if (upsertError) {
			for (const slot of chunk) {
				errors.push({ slot, error: upsertError.message });
			}
			continue;
		}

		for (const slot of chunk) {
			const key = `${slot.channel}|${slot.air_date}|${slot.start_time}`;
			if (existingSet.has(key)) updated++;
			else inserted++;
		}
	}

	return { inserted, updated, errors };
}
