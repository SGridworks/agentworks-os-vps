/**
 * Rule pack evaluator.
 * Takes an ActionEnvelope and a loaded RulePack, returns a typed evaluation result.
 *
 * Evaluation order:
 * 1. Filter rules by actionKind target (pack-level + rule-level)
 * 2. Sort by ascending priority
 * 3. For each rule, check conditions (first-match wins per rule)
 * 4. If all required_data present → evaluate conditions
 * 5. If any required_data missing → disposition_when_missing
 * 6. First non-allow disposition stops evaluation and is returned
 * 7. If all rules return allow → return allow
 */

import { randomUUID } from "node:crypto";
import type { ActionEnvelope, Rule, RulePack } from "@agentworks/shared";
import type { EvaluationResult } from "./types.js";
import { packAppliesToActionKind } from "./loader.js";

function getIn(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, key) => {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    return (cur as Record<string, unknown>)[key];
  }, obj as unknown);
}

function evaluateCondition(
  action: ActionEnvelope,
  condition: Record<string, unknown>
): boolean {
  for (const [field, expected] of Object.entries(condition)) {
    // Look up field across: top-level envelope fields, payload, context.meta
    // This allows conditions to reference actor fields, context-derived fields,
    // and payload fields using the same flat field name
    let actual: unknown = (action as Record<string, unknown>)[field];
    if (actual === undefined) {
      actual = getIn(action.payload as Record<string, unknown>, field);
    }
    if (actual === undefined && action.context.meta) {
      actual = (action.context.meta as Record<string, unknown>)[field];
    }

    if (expected === null) {
      if (actual !== null && actual !== undefined) return false;
    } else if (Array.isArray(expected)) {
      // IN operator: actual is a scalar value that should appear in the expected array
      if (Array.isArray(actual)) return false; // exact array equality — not IN
      const allowed = expected.map(String);
      if (!allowed.includes(String(actual))) return false;
    } else if (typeof expected === "object" && expected !== null) {
      const range = expected as { gte?: string; lt?: string };
      if (typeof actual !== "string") return false;
      if (range.gte !== undefined && actual < range.gte) return false;
      if (range.lt !== undefined && actual >= range.lt) return false;
    } else {
      if (String(actual) !== String(expected)) return false;
    }
  }
  return true;
}

function evaluateRule(
  rule: Rule,
  action: ActionEnvelope,
  packMissingDisposition?: string
): EvaluationResult {
  const missingFields: string[] = [];
  for (const field of rule.required_data) {
    // Check payload first, then context.meta for context-derived fields like localTime
    let value = getIn(action.payload as Record<string, unknown>, field);
    if (value === undefined && action.context.meta) {
      value = (action.context.meta as Record<string, unknown>)[field];
    }
    if (value === null || value === undefined) {
      missingFields.push(field);
    }
  }

  if (missingFields.length > 0) {
    // Per spec: pack-level missing_data_disposition is the default for all rules.
    // A rule's disposition_when_missing only applies when explicitly set (not the Zod default).
    // We use rule.disposition_when_missing directly; the caller (evaluatePack) is
    // responsible for passing pack.missing_data_disposition to this function.
    const disposition = packMissingDisposition ?? rule.disposition_when_missing;
    return {
      decision: disposition as EvaluationResult["decision"],
      reason: `Missing required data: ${missingFields.join(", ")}`,
      matchedRule: rule,
      missingFields,
    };
  }

  for (const clause of rule.conditions) {
    if (evaluateCondition(action, clause.when)) {
      return {
        decision: clause.then.decision,
        reason: clause.then.reason,
        citation: clause.then.citation ?? null,
        matchedRule: rule,
        matchedClause: clause,
      };
    }
  }

  return {
    decision: "allow",
    reason: "No condition matched",
    matchedRule: null,
  };
}

/**
 * Evaluate a single rule pack against an action.
 * Returns the first non-allow decision, or allow if all rules pass.
 */
export function evaluatePack(
  pack: RulePack,
  action: ActionEnvelope,
  shadowMode: boolean = false
): EvaluationResult {
  if (!packAppliesToActionKind(pack, action.actionKind)) {
    return {
      decision: "allow",
      reason: "Action kind not targeted by pack",
      matchedRule: null,
    };
  }

  const applicableRules = [...pack.rules].sort(
    (a, b) => a.priority - b.priority
  );

  // Track last matched rule and its result so allow outcomes preserve rule-specific reason
  let lastMatchedRule: Rule | null = null;
  let lastMatchedResult: EvaluationResult | null = null;

  for (const rule of applicableRules) {
    const result = evaluateRule(rule, action, pack.missing_data_disposition);

    if (result.matchedRule) {
      lastMatchedRule = result.matchedRule;
      lastMatchedResult = result;
    }

    if (result.decision !== "allow") {
      return {
        ...result,
        shadowMode,
      };
    }
  }

  // All rules passed — use last matched result's reason if a condition matched,
  // otherwise "No condition matched"
  if (lastMatchedResult !== null) {
    return {
      decision: "allow",
      reason: lastMatchedResult.reason,
      matchedRule: lastMatchedRule,
      shadowMode,
    };
  }
  return {
    decision: "allow",
    reason: "No condition matched",
    matchedRule: null,
    shadowMode,
  };
}

/**
 * Evaluate multiple packs and return the most severe decision.
 *
 * Severity order: block > route_to_review > allow. A block from any pack
 * wins over a route_to_review from any other, regardless of pack order. This
 * matches real compliance semantics — a hard violation must surface even when
 * other packs route to review for missing data on unrelated dimensions.
 *
 * Within a tie (e.g. two route_to_review), the first-evaluated wins so we
 * keep the most actionable citation for the operator.
 */
export function evaluatePacks(
  packs: RulePack[],
  action: ActionEnvelope,
  shadowMode: boolean = false
): EvaluationResult {
  const SEVERITY: Record<string, number> = {
    block: 3,
    route_to_review: 2,
    allow: 1,
  };

  let best: EvaluationResult | null = null;
  let lastMatchedRule: Rule | null = null;

  for (const pack of packs) {
    const result = evaluatePack(pack, action, shadowMode);
    if (result.matchedRule) {
      lastMatchedRule = result.matchedRule;
    }
    const sev = SEVERITY[result.decision] ?? 0;
    const bestSev = best ? (SEVERITY[best.decision] ?? 0) : 0;
    if (sev > bestSev) {
      best = result;
    }
  }

  if (best && best.decision !== "allow") {
    return best;
  }
  return {
    decision: "allow",
    reason: "All packs passed",
    matchedRule: lastMatchedRule,
    shadowMode,
  };
}

/**
 * Build a complete PolicyDecision record from an evaluation result.
 * The hash chain and timestamps are filled in here.
 */
import { createHash } from "crypto";

export function buildPolicyDecision(
  action: ActionEnvelope,
  result: EvaluationResult,
  pack: RulePack | null,
  prevHash: string | null
): {
  decisionHash: string;
  proposedAt: string;
  decidedAt: string;
  createdAt: string;
} {
  const now = new Date().toISOString();
  // Use the action's proposedAt for deterministic hashing across identical evaluations
  const hashTimestamp = action.proposedAt;
  const content = JSON.stringify({
    actionRequestId: action.requestId,
    decision: result.decision,
    reason: result.reason,
    matchedRuleId: result.matchedRule?.rule_id ?? null,
    prevHash,
    now: hashTimestamp,
  });
  const decisionHash = createHash("sha256").update(content).digest("hex");

  return {
    decisionHash,
    proposedAt: action.proposedAt,
    decidedAt: now,
    createdAt: now,
  };
}
