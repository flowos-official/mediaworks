-- Phase 0.5 follow-up: persist goal_analysis (ParsedGoal) on md_strategies so
-- the detail view can render the search intent chip (intent_tier, channel_scope,
-- specific_keyword). Previously the workflow ran goal_analysis but only used
-- the result in-memory — never saved. Detail page read data.goal_analysis which
-- always evaluated undefined, so the chip never rendered.
--
-- Column is JSONB and nullable to match the existing 6 skill-output columns.
ALTER TABLE md_strategies
  ADD COLUMN IF NOT EXISTS goal_analysis JSONB;

COMMENT ON COLUMN md_strategies.goal_analysis IS
  'Parsed user goal incl. Phase 0.5 SearchIntent fields (intent_tier, channel_scope, specific_keyword). Populated by saveStrategyStep from context.parsedGoal.';
