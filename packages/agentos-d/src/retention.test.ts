/**
 * Audit log retention unit test.
 *
 * Boots a temp SQLite DB, seeds action_log rows at known ages, runs the
 * retention sweep, and asserts that older rows are deleted while newer rows
 * survive.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { initDb, resetDb, getDb, getSqlite } from "./db/client.js";
import { migrate } from "./db/migrations/index.js";
import { actionLog, policyDecisions, type NewActionLogRow } from "./db/schema.js";
import { runAuditLogRetention } from "./retention.js";

let tmpRoot: string;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function rowAt(id: string, ageDays: number): NewActionLogRow {
  const iso = new Date(Date.now() - ageDays * ONE_DAY_MS).toISOString();
  return {
    id,
    tenantId: "t-1",
    actorId: "agent-1",
    actorType: "agent",
    actorLabel: "Test Agent",
    actionKind: "policy.check",
    payloadSnapshot: "{}",
    vaultRefs: "[]",
    conversationRefs: "[]",
    projectRefs: "[]",
    policyDecisionId: null,
    proposedAt: iso,
    loggedAt: iso,
  };
}

beforeEach(() => {
  resetDb();
  tmpRoot = mkdtempSync(join(tmpdir(), "awo-retention-"));
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

describe("audit log retention", () => {
  it("deletes action_log rows older than retention horizon", () => {
    const db = getDb();
    db.insert(actionLog).values([
      rowAt("old-1", 60),
      rowAt("old-2", 45),
      rowAt("edge-1", 31),
      rowAt("fresh-1", 29),
      rowAt("fresh-2", 1),
    ]).run();

    const result = runAuditLogRetention(30);

    expect(result.deleted).toBe(3);

    const remaining = db
      .select({ id: actionLog.id })
      .from(actionLog)
      .all()
      .map((r) => r.id)
      .sort();
    expect(remaining).toEqual(["fresh-1", "fresh-2"]);
  });

  it("retentionDays=0 disables retention (no rows deleted)", () => {
    const db = getDb();
    db.insert(actionLog).values([rowAt("ancient", 365)]).run();

    const result = runAuditLogRetention(0);
    expect(result.deleted).toBe(0);

    const count = db
      .select({ c: sql<number>`count(*)` })
      .from(actionLog)
      .get();
    expect(count?.c).toBe(1);
  });

  it("does NOT touch policy_decisions (hash chain must not be broken)", () => {
    const db = getDb();
    const oldIso = new Date(Date.now() - 60 * ONE_DAY_MS).toISOString();
    db.insert(policyDecisions).values({
      id: "pd-old",
      actionId: "req-old",
      tenantId: "t-1",
      actorId: "agent-1",
      actorType: "agent",
      actorLabel: "Test Agent",
      proposedActionKind: "policy.check",
      proposedActionSummary: "old decision",
      evidenceSnapshot: "{}",
      decision: "block",
      decisionReason: "test fixture",
      shadowMode: false,
      decisionHash: "0".repeat(64),
      proposedAt: oldIso,
      decidedAt: oldIso,
      createdAt: oldIso,
      updatedAt: oldIso,
    }).run();

    runAuditLogRetention(30);

    const surviving = db
      .select({ id: policyDecisions.id })
      .from(policyDecisions)
      .all();
    expect(surviving).toHaveLength(1);
    expect(surviving[0]?.id).toBe("pd-old");
  });

  it("returns ISO cutoff and run timestamp", () => {
    const result = runAuditLogRetention(15);
    expect(result.cutoffIso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.ranAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(result.cutoffIso).getTime()).toBeLessThan(Date.now());
  });
});
