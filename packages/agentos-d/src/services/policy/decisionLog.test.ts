/**
 * decisionLog.test.ts
 *
 * Integration tests for logDecision() using a real in-memory SQLite.
 * Uses the same initDb/resetDb pattern as webhooks.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logDecision } from "./decisionLog.js";
import { initDb, resetDb, getDb } from "../../db/index.js";
import { migrate } from "../../db/migrations/index.js";
import { policyDecisions, approvalQueue } from "../../db/schema.js";
import { eq } from "drizzle-orm";

const TENANT = "test-tenant";

describe("logDecision", () => {
  let tmpRoot: string;

  beforeEach(() => {
    resetDb();
    tmpRoot = mkdtempSync(join(tmpdir(), "decision-log-test-"));
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
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Helper: default options for a route_to_review decision
  function base(overrides = {}) {
    return {
      tenantId: TENANT,
      actor: { id: "actor-1", type: "agent" as const, label: "test-actor" },
      proposedAction: {
        kind: "send_email",
        summary: "Send marketing email",
      },
      evidenceSnapshot: { dnc_status: false, channel: "email" },
      decision: "route_to_review" as const,
      decisionReason: "TCPA routing to review",
      shadowMode: false,
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Basic insertion
  // -------------------------------------------------------------------------

  it("inserts a policy_decisions row with all required fields", () => {
    const result = logDecision(base());
    expect(result.row.id).toBe(result.decisionId);
    expect(result.row.tenantId).toBe(TENANT);
    expect(result.row.actorId).toBe("actor-1");
    expect(result.row.decision).toBe("route_to_review");
    expect(result.row.decisionReason).toBe("TCPA routing to review");
    expect(result.row.shadowMode).toBe(false);
  });

  it("auto-generates actionId when not provided", () => {
    const result = logDecision(base());
    expect(result.row.actionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("uses provided actionId when given", () => {
    const result = logDecision(base({ actionId: "my-action-id" }));
    expect(result.row.actionId).toBe("my-action-id");
  });

  it("stores evidenceSnapshot as a JSON string", () => {
    const result = logDecision(
      base({ evidenceSnapshot: { dnc_status: true, channel: "sms" } }),
    );
    expect(result.row.evidenceSnapshot).toBe(
      '{"dnc_status":true,"channel":"sms"}',
    );
  });

  it("computes decisionHash deterministically from evidence+decision+reason", () => {
    const r1 = logDecision(base());
    const r2 = logDecision(base());
    expect(r1.row.decisionHash).toBe(r2.row.decisionHash);
    expect(r1.row.decisionHash).toHaveLength(64); // SHA-256 hex
  });

  it("sets prevDecisionHash to null on first decision for a tenant", () => {
    const result = logDecision(base());
    expect(result.row.prevDecisionHash).toBeNull();
  });

  it("chains prevDecisionHash to the previous row's hash", () => {
    const first = logDecision(base());
    const second = logDecision(
      base({ actor: { id: "actor-2", type: "human", label: "bob" } }),
    );
    expect(second.row.prevDecisionHash).toBe(first.row.decisionHash);
  });

  // -------------------------------------------------------------------------
  // Optional fields
  // -------------------------------------------------------------------------

  it("stores optional contact fields", () => {
    const result = logDecision(
      base({
        contact: {
          type: "person",
          label: "Jane Doe",
          address: "+15550001111",
        },
      }),
    );
    expect(result.row.contactType).toBe("person");
    expect(result.row.contactLabel).toBe("Jane Doe");
    expect(result.row.contactAddress).toBe("+15550001111");
  });

  it("stores optional channel and jurisdiction", () => {
    const result = logDecision(
      base({ channel: "sms", jurisdiction: "US-CA" }),
    );
    expect(result.row.channel).toBe("sms");
    expect(result.row.jurisdiction).toBe("US-CA");
  });

  it("stores optional consent fields", () => {
    const result = logDecision(
      base({
        consent: {
          source: "written",
          recordRef: "consent-form-123",
          verified: true,
        },
      }),
    );
    expect(result.row.consentSource).toBe("written");
    expect(result.row.consentRecordRef).toBe("consent-form-123");
    expect(result.row.consentVerified).toBe(true);
  });

  it("stores rule pack tracking fields", () => {
    const result = logDecision(
      base({ rulePackId: "rp_tcpa_1", rulePackVersion: "3" }),
    );
    expect(result.row.rulePackId).toBe("rp_tcpa_1");
    expect(result.row.rulePackVersion).toBe("3");
  });

  it("stores override fields", () => {
    const result = logDecision(
      base({
        overriddenBy: "admin-1",
        overriddenByLabel: "Admin Alice",
        originalDecision: "allow",
        overrideReason: "Customer requested reversal",
      }),
    );
    expect(result.row.overriddenBy).toBe("admin-1");
    expect(result.row.overriddenByLabel).toBe("Admin Alice");
    expect(result.row.originalDecision).toBe("allow");
    expect(result.row.overrideReason).toBe("Customer requested reversal");
  });

  it("stores review fields", () => {
    const result = logDecision(
      base({
        reviewedBy: "reviewer-1",
        reviewedByLabel: "Reviewer Bob",
        reviewDecision: "approve",
        reviewNote: "Looks good",
      }),
    );
    expect(result.row.reviewedBy).toBe("reviewer-1");
    expect(result.row.reviewedByLabel).toBe("Reviewer Bob");
    expect(result.row.reviewDecision).toBe("approve");
    expect(result.row.reviewNote).toBe("Looks good");
  });

  // -------------------------------------------------------------------------
  // Shadow mode
  // -------------------------------------------------------------------------

  it("shadowMode=true is stored correctly", () => {
    const result = logDecision(base({ shadowMode: true }));
    expect(result.row.shadowMode).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Approval queue auto-enqueue
  // -------------------------------------------------------------------------

  it("creates approval_queue row when decision=routed_to_review and shadowMode=false", () => {
    const { approvalQueueId } = logDecision(base());
    expect(approvalQueueId).not.toBeNull();

    // Query the real DB to verify the row
    const db = getDb();
    const rows = db.select().from(approvalQueue).all();
    const aqRow = rows.find((r) => r.id === approvalQueueId);
    expect(aqRow).toBeDefined();
    expect(aqRow!.status).toBe("pending");
    expect(aqRow!.actorLabel).toBe("test-actor");
    expect(aqRow!.proposedActionKind).toBe("send_email");
    expect(aqRow!.decisionReason).toBe("TCPA routing to review");
  });

  it("does NOT create approval_queue row when shadowMode=true", () => {
    logDecision(base({ shadowMode: true }));
    const db = getDb();
    const rows = db.select().from(approvalQueue).all();
    expect(rows).toHaveLength(0);
  });

  it("returns null approvalQueueId when shadowMode=true", () => {
    const result = logDecision(base({ shadowMode: true }));
    expect(result.approvalQueueId).toBeNull();
  });

  it("does NOT create approval_queue row when decision=block", () => {
    logDecision(
      base({ decision: "block", decisionReason: "DNC match" }),
    );
    const db = getDb();
    const rows = db.select().from(approvalQueue).all();
    expect(rows).toHaveLength(0);
  });

  it("approval_queue row has policyDecisionId pointing to the decision", () => {
    const { decisionId, approvalQueueId } = logDecision(base());
    const db = getDb();
    const rows = db.select().from(approvalQueue).all();
    const aqRow = rows.find((r) => r.id === approvalQueueId);
    expect(aqRow!.policyDecisionId).toBe(decisionId);
  });
});
