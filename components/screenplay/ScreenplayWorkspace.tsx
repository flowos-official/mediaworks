"use client";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GenerationProgress } from "./GenerationProgress";
import { VersionTimeline } from "./VersionTimeline";
import { ScreenplayViewer } from "./ScreenplayViewer";
import { FeedbackForm } from "./FeedbackForm";
import type { ScreenplayRow, ScreenplayVersionRow } from "@/lib/screenplay/types";

interface Props {
  initialScreenplay: ScreenplayRow;
  initialVersions: ScreenplayVersionRow[];
}

export function ScreenplayWorkspace({ initialScreenplay, initialVersions }: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const [versions, setVersions] = useState(initialVersions);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialScreenplay.current_version_id ?? initialVersions[initialVersions.length - 1]?.id ?? null,
  );
  const [runId, setRunId] = useState<string | null>(search.get("run"));

  useEffect(() => {
    if (!runId) return;
  }, [runId]);

  async function refreshList(newSelectedId?: string) {
    const res = await fetch(`/api/screenplays/${initialScreenplay.id}`, { cache: "no-store" });
    if (!res.ok) return;
    const j = (await res.json()) as { screenplay: ScreenplayRow; versions: ScreenplayVersionRow[] };
    setVersions(j.versions);
    setSelectedId(newSelectedId ?? j.screenplay.current_version_id ?? j.versions[j.versions.length - 1]?.id ?? null);
  }

  function handleComplete(versionId: string) {
    setRunId(null);
    void refreshList(versionId);
    const params = new URLSearchParams(search);
    params.delete("run");
    router.replace(`?${params.toString()}`);
  }

  function handleRefineStart(newRunId: string) {
    setRunId(newRunId);
  }

  const selected = versions.find((v) => v.id === selectedId);
  const isGenerating = !!runId;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr_320px] gap-6">
      <aside className="lg:sticky lg:top-6 self-start">
        <h2 className="text-sm font-bold mb-3">改稿履歴</h2>
        <VersionTimeline
          versions={versions.map((v) => ({ id: v.id, version_number: v.version_number, feedback: v.feedback, created_at: v.created_at }))}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </aside>

      <section className="min-w-0">
        {isGenerating && runId && (
          <div className="mb-4">
            <GenerationProgress runId={runId} onComplete={(versionId) => handleComplete(versionId)} />
          </div>
        )}
        {selected ? (
          <ScreenplayViewer markdown={selected.markdown} title={initialScreenplay.title} />
        ) : (
          <p className="text-sm text-zinc-500">まだバージョンがありません。</p>
        )}
      </section>

      <aside className="lg:sticky lg:top-6 self-start">
        {selected ? (
          <FeedbackForm screenplayId={initialScreenplay.id} baseVersionId={selected.id} disabled={isGenerating} onStart={handleRefineStart} />
        ) : null}
      </aside>
    </div>
  );
}
