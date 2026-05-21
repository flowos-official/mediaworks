/**
 * Runs `fn` with the document forced into light theme + pdf-mode.
 * Restores the prior state in finally{}. Synchronous DOM mutation
 * (not next-themes setTheme) so html2canvas captures match the intended theme.
 */
export async function withLightTheme<T>(fn: () => Promise<T>): Promise<T> {
  const html = document.documentElement;
  const wasDark = html.classList.contains('dark');
  html.classList.remove('dark');
  html.classList.add('pdf-mode');
  try {
    return await fn();
  } finally {
    html.classList.remove('pdf-mode');
    if (wasDark) html.classList.add('dark');
  }
}
