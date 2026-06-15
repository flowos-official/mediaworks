"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";

export default function RetryButton({ productId, label }: { productId: string; label: string }) {
  const t = useTranslations("admin.researchPipeline");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onClick = async () => {
    setPending(true);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/research-pipeline/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(json.error ?? `HTTP ${res.status}`);
        setPending(false);
        return;
      }
      window.location.reload();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("requestFailed"));
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={onClick}
        className="text-xs px-3 py-1.5 rounded border hover:bg-muted disabled:opacity-50"
      >
        {pending ? "..." : label}
      </button>
      {message && <span className="text-xs text-red-600 max-w-[12rem] text-right">{message}</span>}
    </div>
  );
}
