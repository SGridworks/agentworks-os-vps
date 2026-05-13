/**
 * Shared types used across the policy-engine package.
 */

import type { Rule, RulePack, ConditionClause, Disposition, ActionEnvelope } from "@agentworks/shared";

export { type Rule, type RulePack, type ConditionClause, type Disposition };

export interface LoaderOpts {
  /**
   * Extra Zod context values to inject during parsing.
   * Currently unused but reserved for future extensions.
   */
  extra?: Record<string, unknown>;
}

/**
 * Result of evaluating a single rule (or set of rules).
 */
export interface EvaluationResult {
  /** The disposition returned by the first non-passing check. */
  decision: Disposition;
  /** Human-readable explanation of why this decision was made. */
  reason: string;
  /**
   * The rule that triggered this decision.
   * Null if the action kind wasn't targeted, no rules applied, or all passed.
   */
  matchedRule: Rule | null;
  /**
   * The specific condition clause that matched.
   * Present when a condition was evaluated and matched.
   */
  matchedClause?: ConditionClause | null;
  /**
   * The specific field-level citation for the matched clause.
   * Present when citation is set on the matched clause.
   */
  citation?: string | null;
  /**
   * Fields that were required by the rule but absent from the action payload.
   * Present only when decision was triggered by missing data.
   */
  missingFields?: string[];
  /** Whether this evaluation ran in shadow mode (no enforcement). */
  shadowMode?: boolean;
  /**
   * Cognitive budget snapshot at time of evaluation.
   * Populated by the agentos-d route layer when CognitiveSensor is available.
   */
  cognitiveBudget?: {
    activePages: number;
    warmPages: number;
    stalePages: number;
    warmWordCount: number;
    wordBudget: number;
    lastCompactedAt?: string;
  };
}

/**
 * Options passed to the policy engine service.
 */
export interface PolicyEngineOpts {
  /**
   * Directory containing rule pack YAML files.
   * Defaults to ./rule-packs relative to cwd.
   */
  packsDir?: string;

  /**
   * Map of packId → loaded RulePack.
   * If provided, skips loading from disk.
   */
  preloadedPacks?: Map<string, RulePack>;

  /**
   * Default shadow mode for all evaluations.
   * Per-tenant overrides are stored separately (e.g. in the tenant config).
   * Default: false (enforce mode).
   */
  defaultShadowMode?: boolean;
}
