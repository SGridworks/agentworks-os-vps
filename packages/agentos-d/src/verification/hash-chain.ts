/**
 * Policy decision hash-chain verification.
 *
 * Every policy_decisions row stores `decision_hash = sha256(evidence + decision
 * + reason)` and `prev_decision_hash = decisionHash of the previous row for
 * the same tenant`. To verify the chain we walk rows in createdAt order and:
 *
 *   1. Recompute decision_hash from stored evidence/decision/reason; the
 *      stored hash must match (otherwise the row was tampered with).
 *   2. prev_decision_hash must match the previous row's decision_hash, with
 *      `null` only allowed for the first row.
 *
 * If either invariant breaks we return the offending row id and the failure
 * mode so an operator can investigate without scanning the whole table.
 */

import { createHash } from "node:crypto";
import { eq, asc } from "drizzle-orm";
import { policyDecisions } from "../db/schema.js";
import { getDb } from "../db/index.js";

export type ChainBreakReason =
  | "decision_hash_mismatch"
  | "prev_hash_mismatch"
  | "missing_prev_hash";

export interface ChainBreak {
  rowId: string;
  reason: ChainBreakReason;
  expected: string | null;
  actual: string | null;
}

export interface ChainVerificationResult {
  tenantId: string;
  rowsChecked: number;
  ok: boolean;
  breaks: ChainBreak[];
}

function computeHash(
  evidenceStr: string,
  decision: string,
  reason: string,
): string {
  return createHash("sha256")
    .update(evidenceStr + decision + reason)
    .digest("hex");
}

export function verifyHashChain(tenantId: string): ChainVerificationResult {
  const db = getDb();
  const rows = db
    .select({
      id: policyDecisions.id,
      evidenceSnapshot: policyDecisions.evidenceSnapshot,
      decision: policyDecisions.decision,
      decisionReason: policyDecisions.decisionReason,
      decisionHash: policyDecisions.decisionHash,
      prevDecisionHash: policyDecisions.prevDecisionHash,
    })
    .from(policyDecisions)
    .where(eq(policyDecisions.tenantId, tenantId))
    .orderBy(asc(policyDecisions.createdAt), asc(policyDecisions.id))
    .all();

  const breaks: ChainBreak[] = [];
  let prevHash: string | null = null;

  for (const row of rows) {
    const recomputed = computeHash(
      row.evidenceSnapshot,
      row.decision,
      row.decisionReason,
    );
    if (recomputed !== row.decisionHash) {
      breaks.push({
        rowId: row.id,
        reason: "decision_hash_mismatch",
        expected: row.decisionHash,
        actual: recomputed,
      });
    }

    if (prevHash === null) {
      // First row — prev_decision_hash should be null. If it's set, that's a chain break.
      if (row.prevDecisionHash !== null) {
        breaks.push({
          rowId: row.id,
          reason: "prev_hash_mismatch",
          expected: null,
          actual: row.prevDecisionHash,
        });
      }
    } else {
      if (row.prevDecisionHash === null) {
        breaks.push({
          rowId: row.id,
          reason: "missing_prev_hash",
          expected: prevHash,
          actual: null,
        });
      } else if (row.prevDecisionHash !== prevHash) {
        breaks.push({
          rowId: row.id,
          reason: "prev_hash_mismatch",
          expected: prevHash,
          actual: row.prevDecisionHash,
        });
      }
    }

    prevHash = row.decisionHash;
  }

  return {
    tenantId,
    rowsChecked: rows.length,
    ok: breaks.length === 0,
    breaks,
  };
}
