// lib/screenplay/import/constants.ts
// Single source of truth for the imported-markdown length cap, shared by the
// normalizer output guard (parseImportJson) and the server re-submit guard
// (validateImportedMarkdown). No "server-only" — importable from tsx smoke scripts.
export const IMPORT_MARKDOWN_MAX = 60_000;
