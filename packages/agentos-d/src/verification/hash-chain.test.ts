/**
 * Hash-chain verification tests.
 *
 * Boots a temp SQLite DB, seeds policy_decisions rows that follow the chain
 * convention (sha256(evidence+decision+reason), prev_decision_hash linkage),
 * and asserts that:
 *
 *   - a clean chain verifies OK
 *   - tampering with evidence on row N is caught (decision_hash_mismatch)
 *   - rewriting prev_decision_hash on row N is caught (prev_hash_mismatch)
 *   - missing prev_decision_hash on a non-first row is caught
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { initDb, resetDb, getDb } from "../db/client.js";
import { migrate } from "../db/migrations/index.js";
import { policyDecisions, type NewPolicyDecisionRow } from "../db/schema.js";
import { verifyHashChain } from "./hash-chain.js";

let tmpRoot: string;
const TENANT_A = "11111111-1111-1111-1111-111111111111";

function hashOf(evidence: string, decision: string, reason: string): string {
  return createHash("sha256")
    .update(evidence + decision + reason)
    .digest("hex");
}

function rowAt(
  i: number,
  prevHash: string | null,
): NewPolicyDecisionRow & { _hash: string } {
  const evidence = JSON.stringify({ seq: i });
  const decision = "allow" as const;
  const reason = `seq-${i}`;
  const decisionHash = hashOf(evidence, decision, reason);
  const iso = new Date(Date.UTC(2026, 3, 27, 0, 0, i)).toISOString();
  const row: NewPolicyDecisionRow = {
    id: `pd-${i}`,
    actionId: `act-${i}`,
    tenantId: TENANT_A,
    actorId: "agent-1",
    actorType: "agent",
    actorLabel: "Test Agent",
    proposedActionKind: "policy.check",
    proposedActionSummary: `decision-${i}`,
    evidenceSnapshot: evidence,
    decision,
    decisionReason: reason,
    shadowMode: false,
    prevDecisionHash: prevHash,
    decisionHash,
    proposedAt: iso,
    decidedAt: iso,
    createdAt: iso,
    updatedAt: iso,
  };
  return Object.assign(row, { _hash: decisionHash });
}

function seedChain(n: number): string[] {
  const db = getDb();
  const hashes: string[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const row = rowAt(i, prev);
    const { _hash, ...insertable } = row;
    db.insert(policyDecisions).values(insertable).run();
    hashes.push(_hash);
    prev = _hash;
  }
  return hashes;
}

beforeEach(() => {
  resetDb();
  tmpRoot = mkdtempSync(join(tmpdir(), "awo-hashchain-"));
  initDb({
    config: {
      host: "127.0.0.1",
      port: 0,
      logLevel: "warn",
      awcpVersion: "awcp/v0.1",
      dataDir: tmpRoot,
      scannerSidecarUrl: "http://127.0.0.1:0",
      scannerPollIntervalMs: 30_000,
      auditLogRetentionDays: 30,
    },
    migrations: migrate,
  });
});

afterEach(() => {
  resetDb();
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("hash-chain verification", () => {
  it("verifies a clean 3-row chain", () => {
    seedChain(3);
    const result = verifyHashChain(TENANT_A);
    expect(result.rowsChecked).toBe(3);
    expect(result.ok).toBe(true);
    expect(result.breaks).toEqual([]);
  });

  it("returns ok on an empty tenant (no rows)", () => {
    const result = verifyHashChain(TENANT_A);
    expect(result.rowsChecked).toBe(0);
    expect(result.ok).toBe(true);
  });

  it("catches tampered evidence on the middle row", () => {
    seedChain(3);
    const db = getDb();
    db.update(policyDecisions)
      .set({ evidenceSnapshot: JSON.stringify({ seq: 999, tampered: true }) })
      .where(eq(policyDecisions.id, "pd-1"))
      .run();

    const result = verifyHashChain(TENANT_A);
    expect(result.ok).toBe(false);
    expect(result.breaks.length).toBeGreaterThanOrEqual(1);
    const direct = result.breaks.find(
      (b) => b.rowId === "pd-1" && b.reason === "decision_hash_mismatch",
    );
    expect(direct).toBeDefined();
  });

  it("catches a rewritten prev_decision_hash", () => {
    seedChain(3);
    const db = getDb();
    db.update(policyDecisions)
      .set({ prevDecisionHash: "0".repeat(64) })
      .where(eq(policyDecisions.id, "pd-2"))
      .run();

    const result = verifyHashChain(TENANT_A);
    expect(result.ok).toBe(false);
    const link = result.breaks.find(
      (b) => b.rowId === "pd-2" && b.reason === "prev_hash_mismatch",
    );
    expect(link).toBeDefined();
    expect(link?.actual).toBe("0".repeat(64));
  });

  it("catches missing prev_decision_hash on a non-first row", () => {
    seedChain(3);
    const db = getDb();
    db.update(policyDecisions)
      .set({ prevDecisionHash: null })
      .where(eq(policyDecisions.id, "pd-1"))
      .run();

    const result = verifyHashChain(TENANT_A);
    expect(result.ok).toBe(false);
    const link = result.breaks.find(
      (b) => b.rowId === "pd-1" && b.reason === "missing_prev_hash",
    );
    expect(link).toBeDefined();
  });

  it("scopes verification to a single tenant", () => {
    seedChain(2);
    const result = verifyHashChain(
      "00000000-0000-0000-0000-000000000099",
    );
    expect(result.rowsChecked).toBe(0);
    expect(result.ok).toBe(true);
  });
});
