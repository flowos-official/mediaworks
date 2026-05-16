import { politeFetch } from "@/lib/broadcasts/fetch";
import { parseSlotJson, slotJsonUrl } from "./slot-json-parser";
import type { SlotParseResult } from "./types";

/** Fetch + parse one slot's JSON. Returns null on network/JSON error. */
export async function fetchSlot(
	airDate: string,
	startTime: string,
): Promise<SlotParseResult | null> {
	const url = slotJsonUrl(airDate, startTime);
	const fetched = await politeFetch(url, { timeoutMs: 10_000 });
	if (!fetched.ok || !fetched.body) return null;
	try {
		const json = JSON.parse(fetched.body) as unknown;
		return parseSlotJson(json);
	} catch {
		return null;
	}
}
