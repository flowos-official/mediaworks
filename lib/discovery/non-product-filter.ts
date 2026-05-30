/**
 * Heuristic reject for non-product landing/listing/recruitment/search pages that
 * Brave site:-search surfaces alongside real products from TV-shopping channels.
 * Pure (no I/O, no server-only) so it is shared by both the daily-discovery
 * ingest (lib/discovery/pool.ts) and the strategy fresh-search path
 * (lib/md-strategy.ts), and is tsx-importable.
 *
 * CONSERVATIVE BY DESIGN: only clear listing markers + listing URL paths. It does
 * NOT reject bare "ランキング" (legit products carry "楽天ランキング1位" in the name),
 * and it does NOT try to detect pure "カテゴリ名 | チャンネル名" breadcrumb pages by
 * shape — that risks dropping real products, so some category pages still leak.
 * The durable fix for those is product-page detection at scrape time (JSON-LD
 * @type=Product) + a pool backfill, tracked separately.
 */

const NON_PRODUCT_TITLE_RE =
	/検索結果|採用情報|募集要項|商品一覧|の一覧|一覧$|すべての商品|通販[【「]|よくある質問|並び順|ページ目|グループサイト|無料ダウンロード|アプリをダウンロード/;

// Only UNAMBIGUOUS non-product path segments. Deliberately NOT category/list/
// ranking: several registered channels host real product-detail pages under
// /category/{NAME}/{id}.html (shop.asahi.co.jp — senobura/rakurakum/uranoura)
// and /ranking//list/ can be intermediate path segments of product URLs.
// True listing pages are caught by the title markers above.
const NON_PRODUCT_URL_RE = /\/(search|recruit|saiyo|faq)(\/|\?|$)/i;

export function isNonProductPage(
	title: string | null | undefined,
	url: string | null | undefined,
): boolean {
	if (title && NON_PRODUCT_TITLE_RE.test(title)) return true;
	if (url) {
		try {
			if (NON_PRODUCT_URL_RE.test(new URL(url).pathname.toLowerCase())) return true;
		} catch {
			/* unparseable URL — title guard above already ran */
		}
	}
	return false;
}
