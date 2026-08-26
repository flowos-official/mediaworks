/**
 * Fixed vocabulary for `broadcasts.analysis_error`.
 *
 * That column is anon-readable: `broadcasts` carries the loose
 * `for all to authenticated, anon using (true)` policy from
 * supabase/migrations/2026-05-13_auth_rls_loose.sql, and the anon key ships
 * to the browser. A raw exception message must never land there — V8's
 * JSON.parse SyntaxError embeds a snippet of its input, and when Gemini
 * returns prose instead of JSON that input is the competitor's own
 * broadcast transcript:
 *   JSON.parse("本日はレイコップと…")
 *     → Unexpected token '本', "本日はレイコップとダ"... is not valid JSON
 *
 * Every write to analysis_error must be one of these codes. The full
 * message still goes to console.error (function logs only, never the DB) so
 * operators can diagnose the real cause.
 */
export type AnalysisErrorCode =
	| "no_archived_video"
	| "no_category"
	| "config_error"
	| "s3_fetch_failed"
	| "ffmpeg_failed"
	| "runtime_unknown"
	| "low_coverage"
	| "gemini_timeout"
	| "gemini_error"
	| "parse_failed"
	| "stale_recovered"
	| "unknown";
