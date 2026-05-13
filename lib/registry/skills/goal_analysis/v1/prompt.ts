/**
 * Goal Analysis — Skill 0 of the MD Strategy pipeline.
 * Parses the user's free-text expansion goal into a structured ParsedGoal
 * that all downstream skills can reference via buildGoalSection().
 *
 * Verbatim copy of lib/md-strategy.ts:runGoalAnalysis prompt as of 2026-05-13.
 * The {{userGoal}} placeholder is substituted at runtime.
 */

export const PROMPT_TEMPLATE = `You are a business strategy analyst. Parse the following user goal into structured components.

User Goal: {{userGoal}}

Return a JSON object (no markdown) with this structure:
{
  "primary_objective": "主要な目的を1文で",
  "target_channels": ["対象チャネル名のリスト"],
  "target_revenue": "目標売上（言及されている場合）",
  "target_audience": "ターゲット層（言及されている場合）",
  "budget_constraint": "予算制約（言及されている場合）",
  "timeline": "タイムライン（言及されている場合）"
}

IMPORTANT:
- すべてのテキストフィールドは日本語で記述してください。
- primary_objective は必ず文字列で返してください（空でも空文字列 ""）。
- target_channels は必ず配列で返してください。具体的なチャネルが目標から読み取れない場合は [] を返してください。null は使わないでください。
- target_revenue / target_audience / budget_constraint / timeline は言及されていなければ null を返してください。`;

export interface GoalAnalysisInput {
	userGoal: string;
}

export function buildPrompt(input: GoalAnalysisInput): string {
	return PROMPT_TEMPLATE.replaceAll("{{userGoal}}", input.userGoal);
}
