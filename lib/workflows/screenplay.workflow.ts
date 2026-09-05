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
import { geminiUserFacingMessage } from "@/lib/gemini/errors";
import type { CategoryPattern } from "@/lib/broadcast-intel/category-pattern";
import { formatCategoryPatternBlock } from "@/lib/broadcast-intel/format-prompt";
import {
  buildScreenplayContext,
  type ScreenplayGenerationContext,
} from "@/lib/screenplay/context/build";
import { formatStructurePlanBlock } from "@/lib/screenplay/context/structure-plan";
import { buildClaimLinks, claimsNeedingReview } from "@/lib/screenplay/grounding/claim-links";
import { geminiClaimClassifier } from "@/lib/screenplay/grounding/claim-classifier-gemini";
import {
  findReferencePhraseOverlap,
  loadReferencePhrases,
} from "@/lib/screenplay/grounding/copy-guard";

/**
 * Everything the draft will rest on, assembled and persisted BEFORE a word is
 * written: the fact pack, the reference broadcasts, the pattern state with its
 * reason, the running order, and the knowledge snapshot naming every piece of
 * evidence behind them.
 *
 * This replaces loadPatternStep, which time-boxed the pattern lookup and then
 * threw away everything except the pattern itself — including which of five
 * different reasons explained an absent one. The time-boxing and the
 * never-fail behaviour now live in loadPatternResult, so they still hold, and
 * the reason survives into the row.
 */
async function buildContextStep(
  input: ScreenplayWorkflowInput,
  runId: string,
): Promise<ScreenplayGenerationContext> {
  "use step";
  await writeProgressInline({ type: "step", name: "context", status: "started" });
  try {
    const context = await buildScreenplayContext(getServiceClient(), {
      screenplayId: input.screenplayId,
      runId,
      canonicalProductId: input.canonicalProductId ?? null,
      brief: input.productBrief,
      mode: input.mode === "refine" ? "refine" : "initial",
      ...(input.baseVersionId ? { baseVersionId: input.baseVersionId } : {}),
    });
    await writeProgressInline({
      type: "step",
      name: "context",
      status: "completed",
      detail: `pattern:${context.patternResult.status} refs:${context.referenceBroadcasts.length}`,
    });
    return context;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeProgressInline({ type: "step", name: "context", status: "failed", detail: msg });
    throw err;
  }
}

export interface ScreenplayWorkflowInput {
  screenplayId: string;
  mode: GenerationMode;
  productBrief: ProductBrief;
  /** The canonical product the brief describes, when it came from the product
   *  finder. Null for uploaded or manually entered products. */
  canonicalProductId?: string | null;
  feedback?: string;
  baseVersionId?: string;
  /** Present only in mode "import": operator-reviewed, pre-normalized v1 markdown. */
  importedMarkdown?: string;
  /** Identifies this generation for the knowledge snapshot and the generation
   *  context, both of which are unique on it. Required, and minted by
   *  startScreenplayGeneration: a workflow body is replayed, so it cannot mint
   *  one itself without breaking determinism, and a value derived from the
   *  screenplay would collide on the second refine. Distinct from the DevKit's
   *  own run id, which is what the client streams from. */
  runId: string;
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
  patternBlock: string,
  structurePlanBlock: string,
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
        patternBlock,
        structurePlanBlock,
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
  patternSnapshot: CategoryPattern | null,
  generationContextId: string | null,
  markReady: boolean,
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
        ...(patternSnapshot ? { pattern_snapshot: patternSnapshot } : {}),
        generation_context_id: generationContextId,
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

  // A generated version is NOT ready yet: it becomes the screenplay's current
  // version only once its claims have been grounded. An import has no claims to
  // ground — the operator's own draft is the contract — so it is ready here.
  if (markReady) await markReadyStep(screenplayId, versionRow.id);

  return { versionId: versionRow.id, versionNumber: versionRow.version_number };
}

async function markReadyStep(screenplayId: string, versionId: string): Promise<void> {
  "use step";
  const { error } = await getServiceClient()
    .from("screenplays")
    .update({
      current_version_id: versionId,
      status: "ready",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", screenplayId);
  if (error) throw new FatalError(`failed to update screenplay: ${error.message}`);
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

async function checkOnlyStep(
  markdown: string,
  brief: ProductBrief,
  rules: ComplianceRule[],
  references: ComplianceReference[],
): Promise<ScriptCheckResult | null> {
  "use step";
  await writeProgressInline({ type: "step", name: "check", status: "started" });
  const check = await safeCheck(markdown, brief, rules, references);
  await writeProgressInline({ type: "step", name: "check", status: "completed" });
  return check;
}

async function persistCheckStep(
  versionId: string,
  check: ScriptCheckResult | null,
  trail: RemediationStep[],
  rulesLen: number,
  refsLen: number,
  autoRemediateEnabled: boolean,
  competitorCopy?: ScriptCheckResult["competitorCopy"],
): Promise<void> {
  "use step";
  // Non-fatal: a failed persist must NEVER fail the generation.
  if (!check) return;
  try {
    const supabase = getServiceClient();
    const result: ScriptCheckResult = {
      ...check,
      remediation: { enabled: autoRemediateEnabled, iterations: trail, finalHigh: countHigh(check) },
      ...(competitorCopy === undefined ? {} : { competitorCopy }),
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

/**
 * Ground the finished script, then record it.
 *
 * Runs AFTER remediation and after the version exists: a claim link points at
 * a version_id, and remediation rewrites lines, so grounding the pre-remediation
 * draft would attach line numbers to text that no longer exists.
 *
 * Failure here is fatal to the run. A version with no claim links is
 * indistinguishable from one whose every claim was checked and cleared, and it
 * is the second reading a person makes. Better a failed screenplay than a
 * silently ungrounded one.
 */
async function persistClaimLinksStep(
  versionId: string,
  markdown: string,
  context: ScreenplayGenerationContext,
): Promise<{ total: number; needsReview: number }> {
  "use step";
  await writeProgressInline({ type: "step", name: "grounding", status: "started" });
  try {
    const drafts = await buildClaimLinks(
      markdown,
      context.productFactPack,
      geminiClaimClassifier(context.screenplayId),
    );
    const supabase = getServiceClient();
    if (drafts.length > 0) {
      const { error } = await supabase.from("screenplay_claim_links").insert(
        drafts.map((draft) => ({
          version_id: versionId,
          line_start: draft.lineStart,
          line_end: draft.lineEnd,
          claim_text: draft.claimText,
          status: draft.status,
          evidence_item_id: draft.evidenceItemId,
          reason: draft.reason,
        })),
      );
      if (error) throw new FatalError(`claim link insert failed: ${error.message}`);
    }
    const needsReview = claimsNeedingReview(drafts).length;
    await writeProgressInline({
      type: "step",
      name: "grounding",
      status: "completed",
      detail: `claims:${drafts.length} needs_review:${needsReview}`,
    });
    return { total: drafts.length, needsReview };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await writeProgressInline({ type: "step", name: "grounding", status: "failed", detail: msg });
    throw err;
  }
}

/**
 * Did we write their script? Non-fatal by design: this is a check ON our
 * output, not a precondition for having produced it, and a guard that could
 * fail a generation would eventually be turned off.
 */
async function copyGuardStep(
  markdown: string,
  context: ScreenplayGenerationContext,
): Promise<ScriptCheckResult["competitorCopy"]> {
  "use step";
  try {
    const phrases = await loadReferencePhrases(
      getServiceClient(),
      context.referenceBroadcasts.map((r) => r.analysisId),
    );
    if (phrases.length === 0) return [];
    // The product name and the operator's own guarantee wording are ours; a
    // collision on them is not copying.
    const exclusions = [
      context.productFactPack.facts.find((f) => f.key === "name")?.value,
      context.productFactPack.facts.find((f) => f.key === "guarantee")?.value,
    ].filter((v): v is string => typeof v === "string");
    const overlaps = findReferencePhraseOverlap(markdown, phrases, exclusions);
    if (overlaps.length > 0) {
      console.warn(
        `[screenplay] ${context.screenplayId}: ${overlaps.length} passage(s) overlap a reference broadcast (longest ${overlaps[0].length} chars)`,
      );
    }
    return overlaps;
  } catch (err) {
    console.warn("[screenplay] copy guard failed (non-fatal):", err instanceof Error ? err.message : String(err));
    return undefined;
  }
}

async function markFailedStep(screenplayId: string, message: string): Promise<void> {
  "use step";
  const supabase = getServiceClient();
  await supabase
    .from("screenplays")
    .update({
      status: "failed",
      last_error: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("id", screenplayId);
  await writeProgressInline({ type: "error", message });
}

export async function screenplayWorkflow(input: ScreenplayWorkflowInput) {
  "use workflow";

  try {
    if (input.mode === "import") {
      if (!input.importedMarkdown) throw new FatalError("import mode requires importedMarkdown");
      await emitProgressStep({ type: "step", name: "import", status: "started" });
      const markdown = input.importedMarkdown;
      await emitProgressStep({ type: "step", name: "import", status: "completed" });

      const { rules, references } = await loadComplianceStep();
      // Faithful import: corpus-only check, NO auto-remediate (the draft is the contract).
      const check = await checkOnlyStep(markdown, input.productBrief, rules, references);

      // Null generation context, honestly: an import generates no prose, so
      // there is nothing it was written FROM. A row that claimed one would be
      // asserting grounding the operator's own draft never had.
      const persisted = await persistStep(
        input.screenplayId,
        markdown,
        "Word ドラフト取り込み",
        undefined,
        "imported",
        "none",
        null,
        null,
        true,
      );
      await persistCheckStep(persisted.versionId, check, [], rules.length, references.length, false);

      await emitProgressStep({
        type: "done",
        screenplayId: input.screenplayId,
        versionId: persisted.versionId,
        versionNumber: persisted.versionNumber,
      });
      return { screenplayId: input.screenplayId, ...persisted };
    }

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

    // Built and persisted before the draft, so a generation that dies at the
    // model still leaves a readable account of what it was about to write from.
    const context = await buildContextStep(input, input.runId);
    const patternBlock = context.patternResult.pattern
      ? formatCategoryPatternBlock(context.patternResult.pattern)
      : "";
    const structurePlanBlock = formatStructurePlanBlock(context.structurePlan);

    const gen = await generateStep(
      input,
      previousMarkdown,
      complianceBlock,
      patternBlock,
      structurePlanBlock,
    );

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
      // Copied from the context so the legacy column and the new table can
      // never disagree about which aggregate shaped this version.
      context.patternResult.pattern,
      context.id,
      false,
    );

    const competitorCopy = await copyGuardStep(markdown, context);
    await persistCheckStep(
      persisted.versionId,
      check,
      trail,
      rules.length,
      references.length,
      AUTO_REMEDIATE,
      competitorCopy,
    );

    // Fatal if it fails: a version with no claim links reads exactly like one
    // whose every claim was checked and cleared.
    await persistClaimLinksStep(persisted.versionId, markdown, context);

    // Only now. A draft whose claims could not be grounded never becomes the
    // screenplay a person opens.
    await markReadyStep(input.screenplayId, persisted.versionId);

    await emitProgressStep({
      type: "done",
      screenplayId: input.screenplayId,
      versionId: persisted.versionId,
      versionNumber: persisted.versionNumber,
    });
    return { screenplayId: input.screenplayId, ...persisted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[screenplay-workflow] ${input.screenplayId} failed:`, msg);
    const publicMessage =
      geminiUserFacingMessage(err) ??
      "台本生成中にエラーが発生しました。入力内容を確認し、解消しない場合は管理者に連絡してください。";
    await markFailedStep(input.screenplayId, publicMessage);
    throw err;
  }
}
