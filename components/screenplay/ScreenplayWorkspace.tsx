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

function pad(n: number, w: number): string {
  return n.toString().padStart(w, "0");
}

export function ScreenplayWorkspace({ initialScreenplay, initialVersions }: Props) {
  const router = useRouter();
  const search = useSearchParams();
  const [versions, setVersions] = useState(initialVersions);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialScreenplay.current_version_id ?? initialVersions[initialVersions.length - 1]?.id ?? null,
  );
  const [runId, setRunId] = useState<string | null>(search.get("run"));

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
    <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)_320px] gap-10 lg:gap-12">
      {/* LEFT RAIL — REVISION TIMELINE */}
      <aside className="lg:sticky lg:top-8 self-start">
        <div className="font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500 pb-3 border-b border-stone-300 mb-4">
          Revisions <span className="text-stone-900 tabular-nums ml-1">({pad(versions.length, 2)})</span>
        </div>
        <VersionTimeline
          versions={versions.map((v) => ({
            id: v.id,
            version_number: v.version_number,
            feedback: v.feedback,
            created_at: v.created_at,
          }))}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </aside>

      {/* CENTER — SCRIPT VIEWER */}
      <section className="min-w-0">
        {isGenerating && runId && (
          <div className="mb-6">
            <GenerationProgress runId={runId} onComplete={(versionId) => handleComplete(versionId)} />
          </div>
        )}
        {selected ? (
          <ScreenplayViewer
            markdown={selected.markdown}
            title={initialScreenplay.title}
            versionLabel={`V${pad(selected.version_number, 2)}`}
            createdAt={selected.created_at}
          />
        ) : !isGenerating ? (
          <div className="border border-dashed border-stone-300 bg-white px-10 py-20 text-center">
            <div className="font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500 mb-2">No Take Yet</div>
            <p className="text-sm text-stone-600">
              まだバージョンがありません。<br />
              右側パネルから最初のテイクを録ってください。
            </p>
          </div>
        ) : null}
      </section>

      {/* RIGHT RAIL — DIRECTOR'S NOTE */}
      <aside className="lg:sticky lg:top-8 self-start">
        {selected ? (
          <FeedbackForm
            screenplayId={initialScreenplay.id}
            baseVersionId={selected.id}
            disabled={isGenerating}
            onStart={handleRefineStart}
          />
        ) : (
          <div className="font-mono text-[10px] tracking-[0.3em] uppercase text-stone-500">
            Awaiting first take…
          </div>
        )}
      </aside>
    </div>
  );
}
