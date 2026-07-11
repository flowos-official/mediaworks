export default function LocaleLoading() {
  return (
    <main className="mw-page" aria-busy="true" aria-label="Loading page">
      <div className="mw-panel p-5 sm:p-6">
        <div className="h-3 w-32 animate-pulse rounded bg-muted" />
        <div className="mt-3 h-7 w-56 max-w-full animate-pulse rounded-lg bg-muted" />
        <div className="mt-3 h-4 w-80 max-w-full animate-pulse rounded bg-muted/80" />
      </div>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="mw-panel h-32 animate-pulse bg-muted/35" />
        ))}
      </div>
      <div className="mw-panel mt-4 h-80 animate-pulse bg-muted/25" />
      <span className="sr-only">Loading…</span>
    </main>
  );
}
