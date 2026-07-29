export function buildAnalyzeTriggerHeaders(
  cronSecret: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cronSecret) headers.Authorization = `Bearer ${cronSecret}`;
  return headers;
}
