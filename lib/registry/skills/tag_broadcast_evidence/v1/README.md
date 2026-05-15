# tag_broadcast_evidence · v1

Batch-classifies discovery candidates against competitor TV-shopping broadcasts (QVC / ジャパネット / ショップチャンネル / テレ東ポシュレ). Used as a soft ranking boost via `applyBroadcastBoost` — never as exclusion.

## Output

`BroadcastResult[]` — one per candidate with `productUrl`, `tag`, and citation `sources[]`.

## Change log

- **v1 (2026-05-13)** — initial registry version.
