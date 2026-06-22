// Second daily run of the OA broadcast crawl, in the afternoon JST.
//
// The primary run is 01:30 JST (`daily-historical-broadcasts`). Some sources
// publish the day's / week's new content AFTER that early-morning run — most
// notably らくらくマート (rakuraku), whose new "MM/DD(月)週放送分" section goes up
// during Monday daytime, so the 01:30 Monday run misses it and it only appeared
// the next morning. This second run (17:00 JST) re-crawls the same way so
// same-day content is captured the same day. The crawl is idempotent
// (UNIQUE(channel, air_date, product_name) upsert), so the extra run is safe and
// cheap — it just fills in anything published since 01:30.
//
// Reuses the exact handler (auth, crawlAll, finalizeRun, cache revalidation,
// silent-zero alert) — no logic is duplicated.
export { GET } from "../daily-historical-broadcasts/route";

export const maxDuration = 300;
