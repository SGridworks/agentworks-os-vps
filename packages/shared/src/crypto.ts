/**
 * RFC 002 — Hash Chain Utility
 * SHA-256 chain for tamper-evident PolicyDecision records.
 * Algorithm: RFC 002 Section "Hash Chain Algorithm"
 *
 * Usage:
 *   const hash = computeDecisionHash(record, prevHash)
 *   const isValid = verifyDecisionHash(record, prevHash)
 */

import { createHash } from "crypto";

const GENESIS_HASH = "GENESIS";

/**
 * Compute the SHA-256 decision hash for a PolicyDecision record.
 * Input order matters — must match verifyDecisionHash exactly.
 */
export function computeDecisionHash(params: {
  id: string;
  actionId: string;
  decision: string;
  decisionReason: string;
  prevDecisionHash: string | undefined;
  createdAt: string;
}): string {
  const prev = params.prevDecisionHash ?? GENESIS_HASH;
  const input = [
    params.id,
    params.actionId,
    params.decision,
    params.decisionReason,
    prev,
    params.createdAt,
  ].join("|");

  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Verify a decision hash matches the computed value for the given record.
 */
export function verifyDecisionHash(params: {
  id: string;
  actionId: string;
  decision: string;
  decisionReason: string;
  prevDecisionHash: string | undefined;
  createdAt: string;
  decisionHash: string;
}): boolean {
  const computed = computeDecisionHash(params);
  return computed === params.decisionHash;
}

/**
 * Chain integrity check — verifies a list of decision records in order.
 * Returns the index of the first broken link, or -1 if the chain is intact.
 */
export function verifyChainIntegrity(
  records: Array<{
    id: string;
    actionId: string;
    decision: string;
    decisionReason: string;
    prevDecisionHash: string | undefined;
    decisionHash: string;
    createdAt: string;
  }>
): { valid: boolean; brokenAt?: number } {
  let prevHash: string | undefined;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    if (record.prevDecisionHash !== prevHash) {
      return { valid: false, brokenAt: i };
    }

    const expectedHash = computeDecisionHash({
      id: record.id,
      actionId: record.actionId,
      decision: record.decision,
      decisionReason: record.decisionReason,
      prevDecisionHash: record.prevDecisionHash,
      createdAt: record.createdAt,
    });

    if (expectedHash !== record.decisionHash) {
      return { valid: false, brokenAt: i };
    }

    prevHash = record.decisionHash;
  }

  return { valid: true };
}
