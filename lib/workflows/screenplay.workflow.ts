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
import {
  loadActiveRules,
  loadActiveReferences,
  checkScreenplay,
  callGemini,
} from "@/lib/screenplay/compliance/check";
import { buildGenerationComplianceBlock } from "@/lib/screenplay/compliance/context";
import { hasHighViolation, remediableFindings, countHigh } from "@/lib/screenplay/compliance/triggers";
import { remediate } from "@/lib/screenplay/remediate";
import type {
  ComplianceRule,
  ComplianceReference,
  ScriptCheckResult,
  RemediationStep,
} from "@/lib/screenplay/compliance/types";

export interface ScreenplayWorkflowInput {
  screenplayId: string;
  mode: GenerationMode;
  productBrief: ProductBrief;
  feedback?: string;
  baseVersionId?: string;
}

const AUTO_REMEDIATE = process.env.SCREENPLAY_AUTO_REMEDIATE !== "false";
const MAX_REMEDIATE_ITERS = Number(process.env.MAX_REMEDIATE_ITERS ?? "3") || 3;

async function loadComplianceStep(): Promise<{ rules: ComplianceRule[]; references: ComplianceReference[] }> {
  "use step";
  const [rules, references] = await Promise.all([loadActiveRules(), loadActiveReferences()]);
  return { rules, references };
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
  complianceBlock: string,
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
        complianceBlock,
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

async function safeCheck(
  md: string,
  brief: ProductBrief,
  rules: ComplianceRule[],
  references: ComplianceReference[],
): Promise<ScriptCheckResult | null> {
  // Corpus-only (no factSearch) — unreleased copy never leaves the boundary (Codex #1).
  try {
    return await checkScreenplay(md, brief, rules, references);
  } catch (err) {
    console.warn("[remediate] check failed (non-fatal):", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function remediateLoopStep(
  markdown: string,
  brief: ProductBrief,
  rules: ComplianceRule[],
  references: ComplianceReference[],
  complianceBlock: string,
): Promise<{ markdown: string; check: ScriptCheckResult | null; trail: RemediationStep[] }> {
  "use step";
  let md = markdown;
  let check = await safeCheck(md, brief, rules, references);
  const trail: RemediationStep[] = [];
  if (AUTO_REMEDIATE && check) {
    let iter = 0;
    while (hasHighViolation(check) && iter < MAX_REMEDIATE_ITERS) {
      const before = check.overallScore;
      let r;
      try {
        r = await remediate(md, remediableFindings(check), callGemini, { brief, complianceBlock, rules });
      } catch (err) {
        console.warn("[remediate] iteration failed (non-fatal):", err instanceof Error ? err.message : String(err));
        break;
      }
      md = r.md;
      const next = await safeCheck(md, brief, rules, references);
      if (!next) break;
      check = next;
      trail.push({
        iter,
        tier1: r.tier1Count,
        sections: r.sectionsRewritten,
        unlocatable: r.unlocatable,
        scoreBefore: before,
        scoreAfter: check.overallScore,
        residualHigh: countHigh(check),
      });
      iter++;
    }
  }
  return { markdown: md, check, trail };
}

async function persistCheckStep(
  versionId: string,
  check: ScriptCheckResult | null,
  trail: RemediationStep[],
  rulesLen: number,
  refsLen: number,
): Promise<void> {
  "use step";
  // Non-fatal: a failed persist must NEVER fail the generation.
  if (!check) return;
  try {
    const supabase = getServiceClient();
    const result: ScriptCheckResult = {
      ...check,
      remediation: { enabled: AUTO_REMEDIATE, iterations: trail, finalHigh: countHigh(check) },
    };
    await supabase.from("screenplay_version_checks").insert({
      version_id: versionId,
      overall_score: check.overallScore,
      result,
      lexicon_version: `rules:${rulesLen} refs:${refsLen} h:${check.grounding?.corpusHash ?? ""}`,
      is_auto: true,
      created_by: null,
    });
  } catch (err) {
    console.warn("[persistCheckStep] failed (non-fatal):", err instanceof Error ? err.message : String(err));
  }
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

    const { rules, references } = await loadComplianceStep();
    const complianceBlock = buildGenerationComplianceBlock(
      input.productBrief.category ?? null,
      rules,
      references,
    );

    const gen = await generateStep(input, previousMarkdown, complianceBlock);

    const { markdown, check, trail } = await remediateLoopStep(
      gen.markdown,
      input.productBrief,
      rules,
      references,
      complianceBlock,
    );

    const persisted = await persistStep(
      input.screenplayId,
      markdown,
      input.feedback,
      input.baseVersionId,
      gen.model,
      gen.thinkingLevel,
    );

    await persistCheckStep(persisted.versionId, check, trail, rules.length, references.length);

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
