// lib/workflows/screenplay.workflow.ts
import { getWritable, FatalError } from "workflow";
import { generateScreenplay } from "@/lib/screenplay/generator";
import { getServiceClient } from "@/lib/supabase";
import type {
  GenerationMode,
  ProductBrief,
  ProgressEvent,
  ScreenplayVersionRow,
} from "@/lib/screenplay/types";

export interface ScreenplayWorkflowInput {
  screenplayId: string;
  mode: GenerationMode;
  productBrief: ProductBrief;
  feedback?: string;
  baseVersionId?: string;
}

async function writeProgressInline(event: ProgressEvent): Promise<void> {
  const writable = getWritable<ProgressEvent>({ namespace: "progress" });
  const writer = writable.getWriter();
  try {
    await writer.write(event);
  } finally {
    writer.releaseLock();
  }
}

async function emitProgressStep(event: ProgressEvent): Promise<void> {
  "use step";
  await writeProgressInline(event);
}

async function loadPreviousMarkdownStep(baseVersionId: string): Promise<string> {
  "use step";
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("screenplay_versions")
    .select("markdown")
    .eq("id", baseVersionId)
    .single();
  if (error || !data) throw new FatalError(`base version not found: ${baseVersionId}`);
  return data.markdown as string;
}

async function generateStep(
  input: ScreenplayWorkflowInput,
  previousMarkdown: string | undefined,
): Promise<{ markdown: string; model: string; thinkingLevel: string }> {
  "use step";
  await writeProgressInline({ type: "step", name: "generate", status: "started" });
  try {
    const result = await generateScreenplay(
      {
        mode: input.mode,
        productBrief: input.productBrief,
        feedback: input.feedback,
        previousMarkdown,
      },
      (chars) => { void writeProgressInline({ type: "chunk", chars }); },
    );
    await writeProgressInline({ type: "step", name: "generate", status: "completed" });
    return { markdown: result.markdown, model: result.model, thinkingLevel: result.thinkingLevel };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeProgressInline({ type: "step", name: "generate", status: "failed", detail: msg });
    throw err;
  }
}

async function persistStep(
  screenplayId: string,
  markdown: string,
  feedback: string | undefined,
  baseVersionId: string | undefined,
  model: string,
  thinkingLevel: string,
): Promise<{ versionId: string; versionNumber: number }> {
  "use step";
  const supabase = getServiceClient();

  // Retry on unique-constraint races: when multiple refines run in parallel,
  // they may all read the same max version_number and try to insert the same
  // next value. Backoff + re-read up to 5 times.
  let versionRow: Pick<ScreenplayVersionRow, "id" | "version_number"> | null = null;
  let lastErr: { message?: string } | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: existing } = await supabase
      .from("screenplay_versions")
      .select("version_number")
      .eq("screenplay_id", screenplayId)
      .order("version_number", { ascending: false })
      .limit(1);
    const nextVersion = (existing?.[0]?.version_number ?? 0) + 1;

    const { data: inserted, error: insErr } = await supabase
      .from("screenplay_versions")
      .insert({
        screenplay_id: screenplayId,
        version_number: nextVersion,
        markdown,
        feedback: feedback ?? null,
        base_version_id: baseVersionId ?? null,
        model,
        thinking_level: thinkingLevel,
      })
      .select("id, version_number")
      .single();

    if (inserted) {
      versionRow = inserted as Pick<ScreenplayVersionRow, "id" | "version_number">;
      break;
    }
    lastErr = insErr;
    // Unique violation = 23505 → retry. Any other error = fatal.
    const code = (insErr as { code?: string } | null)?.code;
    if (code !== "23505") {
      throw new FatalError(`failed to insert version: ${insErr?.message}`);
    }
    // Small jittered backoff so racing workflows don't lockstep.
    await new Promise((r) => setTimeout(r, 50 + Math.floor(Math.random() * 150)));
  }
  if (!versionRow) {
    throw new FatalError(`failed to insert version after retries: ${lastErr?.message ?? "unknown"}`);
  }

  const { error: updErr } = await supabase
    .from("screenplays")
    .update({
      current_version_id: versionRow.id,
      status: "ready",
      updated_at: new Date().toISOString(),
    })
    .eq("id", screenplayId);
  if (updErr) throw new FatalError(`failed to update screenplay: ${updErr.message}`);

  return { versionId: versionRow.id, versionNumber: versionRow.version_number };
}

async function markFailedStep(screenplayId: string, message: string): Promise<void> {
  "use step";
  const supabase = getServiceClient();
  await supabase
    .from("screenplays")
    .update({ status: "failed", updated_at: new Date().toISOString() })
    .eq("id", screenplayId);
  await writeProgressInline({ type: "error", message });
}

export async function screenplayWorkflow(input: ScreenplayWorkflowInput) {
  "use workflow";

  try {
    let previousMarkdown: string | undefined;
    if (input.mode === "refine") {
      if (!input.baseVersionId) throw new FatalError("refine mode requires baseVersionId");
      previousMarkdown = await loadPreviousMarkdownStep(input.baseVersionId);
    }

    const gen = await generateStep(input, previousMarkdown);
    const persisted = await persistStep(
      input.screenplayId,
      gen.markdown,
      input.feedback,
      input.baseVersionId,
      gen.model,
      gen.thinkingLevel,
    );

    await emitProgressStep({
      type: "done",
      screenplayId: input.screenplayId,
      versionId: persisted.versionId,
      versionNumber: persisted.versionNumber,
    });
    return { screenplayId: input.screenplayId, ...persisted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markFailedStep(input.screenplayId, msg);
    throw err;
  }
}
