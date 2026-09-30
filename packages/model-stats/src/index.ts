/**
 * @role-orchestrator/model-stats — M8-02 read-only model performance
 * statistics. See package.json description and the module docs of
 * schema/parse/store/report/budget for the boundaries:
 * statistics only; cost stays contract-level "unknown"; no API may select,
 * switch or reroute a model; BudgetRefinement emits READ-ONLY threshold
 * suggestions ("ready" | "insufficient-data") that never touch the
 * budget/scheduler execution surfaces — adoption is a maintainer decision.
 */
export {
  COST_UNKNOWN,
  UNKNOWN_MODEL_ID,
  UsageEventSchema,
  isUnknownModelId,
  totalTokens,
  type UsageEvent
} from "./schema.js";
export {
  parseClaudeUsageEvents,
  parseCodexUsageEvents,
  type ClaudeParseOptions,
  type CliDialect,
  type CodexParseOptions,
  type UsageLineError,
  type UsageParseResult
} from "./parse.js";
export { PerformanceStore, type ModelPerformanceSummary } from "./store.js";
export { renderPerformanceReport } from "./report.js";
export {
  MIN_SAMPLES_PER_MODEL,
  BudgetRefinementInputSchema,
  BudgetRefinementOutcomeSchema,
  ModelBudgetSuggestionSchema,
  ModelDataGapSchema,
  ModelPerformanceSummarySchema,
  SuggestionBasisSchema,
  refineBudgetThresholds,
  type BudgetRefinementInput,
  type BudgetRefinementOutcome,
  type ModelBudgetSuggestion,
  type ModelDataGap,
  type SuggestionBasis
} from "./budget.js";
