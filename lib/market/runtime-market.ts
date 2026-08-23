export type RuntimeMarketCountry = "jp" | "kr";

/**
 * The Japanese MediaWorks deployment remains the safe default.  Every
 * server-side read/write that touches the shared JP/KR tables must use this
 * value explicitly instead of relying on database column defaults.
 */
export function getRuntimeMarketCountry(): RuntimeMarketCountry {
	return process.env.NEXT_PUBLIC_APP_VARIANT === "lotte-kr" ? "kr" : "jp";
}

export function getRuntimeScreenplayTenant(): "mediaworks" | "lotte" {
	return getRuntimeMarketCountry() === "kr" ? "lotte" : "mediaworks";
}
