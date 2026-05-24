"use client";
import type { BoardCard } from "@/lib/selections/types";

interface Props {
  card: BoardCard;
  onConfirm: (broadcastId: string | null, note: string | null) => void | Promise<void>;
  onCancel: () => void;
}

// Placeholder — full implementation in Task 15.
export function BroadcastMatchDialog(props: Props): null {
  // Suppress unused param warnings without behaviour.
  void props;
  return null;
}
