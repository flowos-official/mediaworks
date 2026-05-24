import "server-only";
import { revalidateTag } from "next/cache";

export const SELECTIONS_BOARD_TAG = "selections:board";
export const SELECTIONS_COUNTS_TAG = "selections:counts";

const TAGS = [SELECTIONS_BOARD_TAG, SELECTIONS_COUNTS_TAG] as const;

export function invalidateSelectionsAfterMutation(source: string): void {
  for (const tag of TAGS) {
    try {
      revalidateTag(tag, "max");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[cache] revalidateTag failed", { source, tag, error: msg });
    }
  }
}
