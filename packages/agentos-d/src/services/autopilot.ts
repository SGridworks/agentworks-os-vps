/**
 * Autopilot service — implements bucketing logic for automatic action execution.
 * 
 * Evaluates actions based on risk scores and rules to determine whether they should:
 * - Auto-allow (safe actions with low risk)
 * - Block (high risk actions)
 * - Route to approval (medium risk actions)
 * 
 * Stamps riskScore and reasons[] into dispatch_queue.input JSON for any dispatch it touches.
 */

import type { Database } from "better-sqlite3";

export interface AutopilotConfig {
  /** Risk score threshold for auto-allow (default: 0.30) */
  safeThreshold?: number;
  /** Risk score threshold for blocking (default: 0.70) */
  riskyThreshold?: number;
  /** Action types considered safe for auto-allow */
  safeActionTypes?: string[];
}

export interface RiskEvaluation {
  riskScore: number;
  reasons: string[];
  decision: "allow" | "needsApproval" | "risky";
}

export interface ActionTypeRiskScores {
  [actionType: string]: number;
}

// Default action type risk scores from the spec
const DEFAULT_ACTION_TYPE_SCORES: ActionTypeRiskScores = {
  "memory_write": 0.10,
  "file_read": 0.05,
  "http_get": 0.10,
  "http_post": 0.35,
  "shell_read_only": 0.10,
  "shell_mutating": 0.50,
  "email_send": 0.45,
  "sms_send": 0.55,
  "db_write": 0.40,
};

// Default safe action types for auto-allow
const DEFAULT_SAFE_ACTION_TYPES = [
  "memory_write",
  "file_read", 
  "http_get",
  "shell_read_only"
];

// Canonical reason strings from the spec
const REASONS = {
  TCPA_TIME_OF_DAY: "tcpa.time_of_day",
  TCPA_PHONE_INVALID: "tcpa.phone_invalid",
  FAIR_HOUSING_KEYWORD: "fair_housing.keyword_match",
  FAIR_HOUSING_STEERING: "fair_housing.steering",
  HIPAA_PHI_DETECTED: "hipaa.phi_detected",
  PII_HIGH_CONFIDENCE: "pii.high_confidence",
  ACTION_TYPE_HIGH_RISK: "action_type.high_risk",
  RULE_PACK_BLOCK: "rule_pack.block",
  CONTENT_UNSAFE_URL: "content.unsafe_url",
  APPROVAL_HISTORY_RECENT_DENY: "approval_history.recent_deny",
} as const;

export class AutopilotService {
  private readonly sqlite: Database;
  private readonly config: Required<AutopilotConfig>;

  constructor(sqlite: Database, config: AutopilotConfig = {}) {
    this.sqlite = sqlite;
    this.config = {
      safeThreshold: config.safeThreshold ?? 0.30,
      riskyThreshold: config.riskyThreshold ?? 0.70,
      safeActionTypes: config.safeActionTypes ?? DEFAULT_SAFE_ACTION_TYPES,
    };
  }

  /**
   * Evaluate an action for autopilot bucketing.
   * Returns risk score, reasons, and decision without side effects.
   */
  evaluateAction(
    actionType: string,
    policyDecision: {
      decision: "allow" | "block" | "route_to_review";
      rulePackId?: string;
      violations?: Array<{ severity: string; message: string }>;
    },
    contentFlags: {
      hasFairHousingKeywords?: boolean;
      hasTcpaViolations?: boolean;
      hasPhi?: boolean;
      hasHighConfidencePii?: boolean;
      hasUnsafeUrl?: boolean;
      recentDenial?: boolean;
    } = {}
  ): RiskEvaluation {
    const reasons: string[] = [];
    
    // Calculate rule severity score
    let ruleSeverityScore = 0.0;
    if (policyDecision.decision === "block") {
      ruleSeverityScore = 1.0;
      reasons.push(REASONS.RULE_PACK_BLOCK);
    } else if (policyDecision.decision === "route_to_review") {
      ruleSeverityScore = 0.4;
    }

    // Calculate action type score
    const actionTypeScore = DEFAULT_ACTION_TYPE_SCORES[actionType] ?? 0.3;

    // Calculate content score
    let contentScore = 0.0;
    if (contentFlags.hasFairHousingKeywords) {
      contentScore = Math.max(contentScore, 0.3);
      reasons.push(REASONS.FAIR_HOUSING_KEYWORD);
    }
    if (contentFlags.hasTcpaViolations) {
      contentScore = Math.max(contentScore, 0.5);
      reasons.push(REASONS.TCPA_TIME_OF_DAY);
    }
    if (contentFlags.hasPhi) {
      contentScore = Math.max(contentScore, 0.6);
      reasons.push(REASONS.HIPAA_PHI_DETECTED);
    }
    if (contentFlags.hasHighConfidencePii) {
      contentScore = Math.max(contentScore, 1.0);
      reasons.push(REASONS.PII_HIGH_CONFIDENCE);
    }
    if (contentFlags.hasUnsafeUrl) {
      contentScore = Math.max(contentScore, 0.5);
      reasons.push(REASONS.CONTENT_UNSAFE_URL);
    }
    if (contentFlags.recentDenial) {
      contentScore = Math.max(contentScore, 0.3);
      reasons.push(REASONS.APPROVAL_HISTORY_RECENT_DENY);
    }

    // High risk action type
    if (actionTypeScore >= 0.5) {
      reasons.push(REASONS.ACTION_TYPE_HIGH_RISK);
    }

    // Final risk score is the maximum of all components
    const riskScore = Math.max(ruleSeverityScore, actionTypeScore, contentScore);

    // Apply bucketing rules
    let decision: "allow" | "needsApproval" | "risky";
    if (policyDecision.decision === "block" || riskScore >= this.config.riskyThreshold) {
      decision = "risky";
    } else if (
      riskScore <= this.config.safeThreshold &&
      policyDecision.decision === "allow" &&
      this.config.safeActionTypes.includes(actionType) &&
      reasons.length === 0 // No additional risk factors
    ) {
      decision = "allow";
    } else {
      decision = "needsApproval";
    }

    // Deduplicate and cap reasons at 5
    const uniqueReasons = Array.from(new Set(reasons)).slice(0, 5);

    return {
      riskScore: Math.round(riskScore * 100) / 100, // Round to 2 decimal places
      reasons: uniqueReasons,
      decision,
    };
  }

  /**
   * Stamp risk score and reasons into dispatch_queue.input JSON.
   * This is the main entry point for the autopilot bucketing logic.
   */
  stampRiskIntoDispatch(dispatchId: string, evaluation: RiskEvaluation): void {
    // Get current dispatch row
    const row = this.sqlite
      .prepare("SELECT input FROM dispatch_queue WHERE id = ?")
      .get(dispatchId) as { input: string } | undefined;

    if (!row) {
      throw new Error(`Dispatch ${dispatchId} not found`);
    }

    // Parse existing input and merge with risk evaluation
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(row.input) as Record<string, unknown>;
    } catch {
      input = {};
    }

    // Stamp risk evaluation into input
    const updatedInput = {
      ...input,
      riskScore: evaluation.riskScore,
      reasons: evaluation.reasons,
      autopilotDecision: evaluation.decision,
    };

    // Update the dispatch queue row
    this.sqlite
      .prepare("UPDATE dispatch_queue SET input = ? WHERE id = ?")
      .run(JSON.stringify(updatedInput), dispatchId);
  }

  /**
   * Process a dispatch queue row through autopilot bucketing.
   * This reads the action details, evaluates risk, and stamps the result.
   */
  processDispatch(dispatchId: string): RiskEvaluation {
    const row = this.sqlite
      .prepare(`
        SELECT dq.input, dq.task_kind, pd.decision, pd.rule_pack_id
        FROM dispatch_queue dq
        LEFT JOIN policy_decisions pd ON dq.policy_decision_id = pd.id
        WHERE dq.id = ?
      `)
      .get(dispatchId) as {
        input: string;
        task_kind: string;
        decision: "allow" | "block" | "route_to_review" | null;
        rule_pack_id: string | null;
      } | undefined;

    if (!row) {
      throw new Error(`Dispatch ${dispatchId} not found`);
    }

    // Parse input to extract content flags
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(row.input) as Record<string, unknown>;
    } catch {
      input = {};
    }

    // Extract content flags from input (these would typically come from policy evaluation)
    const contentFlags = {
      hasFairHousingKeywords: Boolean(input.hasFairHousingKeywords),
      hasTcpaViolations: Boolean(input.hasTcpaViolations),
      hasPhi: Boolean(input.hasPhi),
      hasHighConfidencePii: Boolean(input.hasHighConfidencePii),
      hasUnsafeUrl: Boolean(input.hasUnsafeUrl),
      recentDenial: Boolean(input.recentDenial),
    };

    // Evaluate action. exactOptionalPropertyTypes forbids passing
    // `undefined` to optional fields; build the object conditionally.
    const policyArg: { decision: "allow" | "block" | "route_to_review"; rulePackId?: string } = {
      decision: (row.decision as "allow" | "block" | "route_to_review") ?? "allow",
    };
    if (row.rule_pack_id) policyArg.rulePackId = row.rule_pack_id;
    const evaluation = this.evaluateAction(row.task_kind, policyArg, contentFlags);

    // Stamp the result into the dispatch queue
    this.stampRiskIntoDispatch(dispatchId, evaluation);

    return evaluation;
  }
}