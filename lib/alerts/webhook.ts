/**
 * Generic webhook POST for ops alerts. Slack/Discord compatible — the caller
 * builds the body. NO `import "server-only"` — used by tsx smoke scripts.
 */
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export async function postWebhook(
  url: string,
  body: object,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, error: `webhook HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
