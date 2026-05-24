"use client";
import { useEffect } from "react";

interface Props {
  card: any; // TODO: replace with BoardCard type in Task 15
  onConfirm: (broadcastId: string | null, note: string | null) => void | Promise<void>;
  onCancel: () => void;
}

// Placeholder — full implementation in Task 15. Auto-cancels so the parent
// kanban does not get stuck with `pendingMove` set.
export function BroadcastMatchDialog({ onCancel }: Props): null {
  useEffect(() => {
    alert("方送予定 이동 UI 는 Task 15 에서 구현 예정입니다. 일단 취소합니다.");
    onCancel();
  }, [onCancel]);
  return null;
}
