export type BroadcastChannel = "shopch" | "qvc";

export interface ScrapedSlot {
	channel: BroadcastChannel;
	air_date: string; // YYYY-MM-DD (JST)
	start_time: string; // HH:MM:SS (JST)
	program_title: string;
	presenter: string | null;
	description: string | null;
	thumbnail_url: string | null;
	source_url: string;
	// Phase B PoC: QVC slots expose `data-products="ID|ID|..."` on the <li>.
	// shopch leaves this null until Phase B full implementation.
	product_ids: string[] | null;
}

export interface ScrapeHealth {
	expectedNonZero: boolean;
	actualCount: number;
	fieldCoverage: {
		presenter: number;
		description: number;
		thumbnail_url: number;
	};
}

export interface ScrapeResult {
	channel: BroadcastChannel;
	date: string; // YYYY-MM-DD
	slots: ScrapedSlot[];
	ok: boolean;
	error?: string;
	health: ScrapeHealth;
}

export interface PersistResult {
	inserted: number;
	updated: number;
	errors: Array<{ slot: ScrapedSlot; error: string }>;
}

export const USER_AGENT =
	"MediaWorks-Broadcast-Calendar/1.0 (+contact@mediaw-b.com)";

export function computeHealth(
	slots: ScrapedSlot[],
	expectedNonZero: boolean,
): ScrapeHealth {
	const n = slots.length;
	const coverage = (key: keyof ScrapedSlot) =>
		n === 0 ? 0 : slots.filter((s) => s[key] != null && s[key] !== "").length / n;
	return {
		expectedNonZero,
		actualCount: n,
		fieldCoverage: {
			presenter: coverage("presenter"),
			description: coverage("description"),
			thumbnail_url: coverage("thumbnail_url"),
		},
	};
}
