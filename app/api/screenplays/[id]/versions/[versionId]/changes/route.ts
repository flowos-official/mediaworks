// app/api/screenplays/[id]/versions/[versionId]/changes/route.ts
import { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth/require-user";
import { getServiceClient } from "@/lib/supabase";
import { computeLineDiff, DIFF_VERSION } from "@/lib/screenplay/diff";
import { explainChanges, PROMPT_VERSION } from "@/lib/screenplay/change-rationale";
import { GEMINI_FLASH } from "@/lib/gemini-models";
import type { ChangeNotes, ChangeNotesKey, HunkReason } from "@/lib/screenplay/types";
import type { Finding, ScriptCheckResult } from "@/lib/screenplay/compliance/types";

export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flattenFindings(r: ScriptCheckResult | null): Finding[] {
  if (!r) return [];
  return [...(r.legal ?? []), ...(r.facts ?? []), ...(r.quality ?? [])].slice(0, 30);
}

function keysEqual(a: ChangeNotesKey, b: ChangeNotesKey): boolean {
  return (
    a.diffVersion === b.diffVersion &&
    a.promptVersion === b.promptVersion &&
    a.model === b.model &&
    a.baseVersionId === b.baseVersionId &&
    a.baseCheckId === b.baseCheckId &&
    a.hunkCount === b.hunkCount
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  const auth = await requireUser(["member", "admin"]);
  if ("error" in auth) return auth.error;
  const { id, versionId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(versionId)) {
    return Response.json({ error: "invalid id" }, { status: 404 });
  }

  const sb = getServiceClient();

  const { data: v } = await sb
    .from("screenplay_versions")
    .select("id, markdown, base_version_id, feedback, change_notes")
    .eq("id", versionId)
    .eq("screenplay_id", id)
    .maybeSingle();
  if (!v) return Response.json({ error: "version not found" }, { status: 404 });
  if (!v.base_version_id) return Response.json({ error: "version has no base to compare" }, { status: 404 });

  const { data: parent } = await sb
    .from("screenplay_versions")
    .select("id, markdown")
    .eq("id", v.base_version_id)
    .eq("screenplay_id", id) // base must belong to the same screenplay
    .maybeSingle();
  if (!parent) return Response.json({ error: "base version not found in this screenplay" }, { status: 404 });

  const { data: checkRow } = await sb
    .from("screenplay_version_checks")
    .select("id, result")
    .eq("version_id", parent.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const findings = flattenFindings((checkRow?.result as ScriptCheckResult) ?? null);
  const baseCheckId: string | null = checkRow?.id ?? null;

  const diff = computeLineDiff(parent.markdown as string, v.markdown as string);
  const key: ChangeNotesKey = {
    diffVersion: DIFF_VERSION,
    promptVersion: PROMPT_VERSION,
    model: GEMINI_FLASH,
    baseVersionId: parent.id as string,
    baseCheckId,
    hunkCount: diff.length,
  };

  const cached = v.change_notes as ChangeNotes | null;
  if (cached?.ok && keysEqual(cached.key, key)) {
    return Response.json({ rationale: cached.rationale, model: key.model, computedAt: cached.computedAt });
  }

  let rationale: HunkReason[];
  let computedAt: string;
  try {
    rationale = await explainChanges(diff, (v.feedback as string | null) ?? null, findings);
    computedAt = new Date().toISOString();
  } catch (err) {
    // Rationale generation failed → return diff-only, do NOT cache (retries next view).
    console.error("[screenplays/changes] rationale failed:", err instanceof Error ? err.message : String(err));
    return Response.json({ rationale: [], model: key.model, computedAt: null });
  }

  // Cache write is best-effort and MUST NOT discard an already-computed rationale:
  // before the change_notes migration is applied (manual in this repo) the UPDATE
  // fails on a missing column, but the AI result is still valid — return it uncached.
  // Note: postgrest-js resolves to { error } on a DB error (it does NOT throw), so
  // capture that explicitly; the try/catch only guards genuine throws (e.g. network).
  const notes: ChangeNotes = { ok: true, key, rationale, computedAt };
  try {
    const { error: writeErr } = await sb
      .from("screenplay_versions")
      .update({ change_notes: notes })
      .eq("id", versionId)
      .eq("screenplay_id", id);
    if (writeErr) {
      console.error("[screenplays/changes] cache write failed (returning uncached):", writeErr.message);
    }
  } catch (err) {
    console.error("[screenplays/changes] cache write threw (returning uncached):", err instanceof Error ? err.message : String(err));
  }
  return Response.json({ rationale, model: key.model, computedAt });
}
