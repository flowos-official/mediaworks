import type { OAChannelSlug } from "../types";
import type { ImageExtractor } from "./types";
import { ogImageExtractor } from "./og-image";

/**
 * Channel → image extractor mapping. Null = unsupported (japanet) or
 * handled inside the parser itself (txd uses its list-API response, no
 * separate fetch).
 *
 * Populated in Tasks 4 (og-image) and 5 (ntv-api). Tasks 6/7 wire each
 * parser to its extractor.
 */
export const IMAGE_EXTRACTORS: Record<OAChannelSlug, ImageExtractor | null> = {
	japanet: null,
	junsanpo: ogImageExtractor,
	ntv: null, // populated in Task 5
	tbs: ogImageExtractor,
	dinos: ogImageExtractor,
	senobura: ogImageExtractor,
	uranoura: ogImageExtractor,
	txd: null, // txd populates image_url inside the parser, not via an extractor
};

export type { ImageExtractor } from "./types";
export { mapWithConcurrency } from "./types";
