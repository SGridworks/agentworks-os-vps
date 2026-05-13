/**
 * Tests for the provenance service.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProvenance } from "./provenance.js";
import type { Database } from "better-sqlite3";
import { getDb, initDb, resetDb } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import type { Config } from "../config.js";

function config(): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    logLevel: "warn",
    awcpVersion: "awcp/v0.1",
    dataDir: dataDir,
    scannerSidecarUrl: "http://127.0.0.1:0",
    scannerPollIntervalMs: 30_000,
    auditLogRetentionDays: 30,
  };
}

let dataDir: string;

describe("provenance service", () => {
  let sqlite: Database;

  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-provenance-"));
    initDb({ config: config(), migrations: migrate });
    sqlite = (getDb() as unknown as { $client: Database }).$client;
    
    // Clean up any existing test data
    sqlite.exec("DELETE FROM action_log WHERE tenant_id = 'test-tenant'");
    sqlite.exec("DELETE FROM policy_decisions WHERE tenant_id = 'test-tenant'");
    sqlite.exec("DELETE FROM episodes WHERE tenant_id = 'test-tenant'");
    sqlite.exec("DELETE FROM insights WHERE tenant_id = 'test-tenant'");
  });

  afterEach(() => {
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("should return provenance data even for non-existent document", async () => {
    const result = await getProvenance("018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", "non-existent.md");
    expect(result).not.toBeNull();
    expect(result!.key).toBe("non-existent.md");
    expect(result!.citations).toEqual([]);
    expect(result!.decisions).toEqual([]);
    expect(result!.conflicts).toBeInstanceOf(Array);
    expect(result!.readWindowDays).toBe(30);
    expect(result!.staleRisk).toBe(false); // No citations, so importance = 1, not stale
  });

  it("should return provenance with empty arrays for new document", async () => {
    // Create a test episode to simulate document existence
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO episodes (id, tenant_id, summary, started_at, ended_at, duration_sec, lifecycle, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-episode-1",
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "Test document content",
      now,
      now,
      60,
      "active",
      now
    );

    const result = await getProvenance("018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", "test-document.md");
    
    expect(result).not.toBeNull();
    expect(result!.key).toBe("test-document.md");
    expect(result!.citations).toEqual([]);
    expect(result!.decisions).toEqual([]);
    expect(result!.conflicts).toBeInstanceOf(Array);
    expect(result!.readWindowDays).toBe(30);
    expect(result!.staleRisk).toBe(false);
  });

  it("should return citations for document referenced in action logs", async () => {
    // Create a test episode first
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO episodes (id, tenant_id, summary, started_at, ended_at, duration_sec, lifecycle, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-episode-1",
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "Test document content",
      now,
      now,
      60,
      "active",
      now
    );

    // Insert test action log with vault refs
    const actionId = "test-action-1";
    const loggedAt = new Date().toISOString();
    const vaultRefs = JSON.stringify(["test-document.md"]);
    
    sqlite.prepare(`
      INSERT INTO action_log (
        id, tenant_id, actor_id, actor_type, actor_label, action_kind,
        payload_snapshot, vault_refs, conversation_refs, project_refs,
        proposed_at, logged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actionId,
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "test-agent-1",
      "agent",
      "Test Agent",
      "memory.read",
      "{}",
      vaultRefs,
      "[]",
      "[]",
      loggedAt,
      loggedAt
    );

    const result = await getProvenance("018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", "test-document.md");
    
    expect(result).not.toBeNull();
    expect(result!.citations).toHaveLength(1);
    expect(result!.citations[0]).toEqual({
      actionId,
      actionKind: "memory.read",
      actorId: "test-agent-1",
      actorLabel: "Test Agent",
      actorType: "agent",
      loggedAt,
      vaultRefs: ["test-document.md"],
    });
    expect(result!.staleRisk).toBe(false); // Document has citations, so importance >= 3, but not stale
  });

  it("should return decisions for document referenced in policy decisions", async () => {
    // Create a test episode first
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO episodes (id, tenant_id, summary, started_at, ended_at, duration_sec, lifecycle, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-episode-1",
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "Test document content",
      now,
      now,
      60,
      "active",
      now
    );

    // Insert test action log and policy decision
    const actionId = "test-action-1";
    const decisionId = "test-decision-1";
    const loggedAt = new Date().toISOString();
    const decidedAt = new Date().toISOString();
    const vaultRefs = JSON.stringify(["test-document.md"]);
    
    // Insert action log
    sqlite.prepare(`
      INSERT INTO action_log (
        id, tenant_id, actor_id, actor_type, actor_label, action_kind,
        payload_snapshot, vault_refs, conversation_refs, project_refs,
        proposed_at, logged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actionId,
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "test-agent-1",
      "agent",
      "Test Agent",
      "policy.check",
      "{}",
      vaultRefs,
      "[]",
      "[]",
      loggedAt,
      loggedAt
    );

    // Insert policy decision
    sqlite.prepare(`
      INSERT INTO policy_decisions (
        id, action_id, tenant_id, actor_id, actor_type, actor_label,
        proposed_action_kind, proposed_action_summary, decision, decision_reason,
        evidence_snapshot, decision_hash, proposed_at, decided_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decisionId,
      actionId,
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "test-agent-1",
      "agent",
      "Test Agent",
      "send_email",
      "Send marketing email",
      "allow",
      "Compliant with policy",
      "{}",
      "test-hash-123",
      loggedAt,
      decidedAt,
      decidedAt,
      decidedAt
    );

    const result = await getProvenance("018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", "test-document.md");
    
    expect(result).not.toBeNull();
    expect(result!.decisions).toHaveLength(1);
    expect(result!.decisions[0]).toEqual({
      decisionId,
      actionId,
      decision: "allow",
      decisionReason: "Compliant with policy",
      proposedActionKind: "send_email",
      proposedActionSummary: "Send marketing email",
      decidedAt,
      actorLabel: "Test Agent",
    });
  });

  it("should handle multiple vault references in single action", async () => {
    // Create a test episode first
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO episodes (id, tenant_id, summary, started_at, ended_at, duration_sec, lifecycle, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-episode-1",
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "Test document content",
      now,
      now,
      60,
      "active",
      now
    );

    // Insert test action log with multiple vault refs
    const actionId = "test-action-1";
    const loggedAt = new Date().toISOString();
    const vaultRefs = JSON.stringify(["document-a.md", "test-document.md", "document-b.md"]);
    
    sqlite.prepare(`
      INSERT INTO action_log (
        id, tenant_id, actor_id, actor_type, actor_label, action_kind,
        payload_snapshot, vault_refs, conversation_refs, project_refs,
        proposed_at, logged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actionId,
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "test-agent-1",
      "agent",
      "Test Agent",
      "memory.read",
      "{}",
      vaultRefs,
      "[]",
      "[]",
      loggedAt,
      loggedAt
    );

    const result = await getProvenance("018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", "test-document.md");
    
    expect(result).not.toBeNull();
    expect(result!.citations).toHaveLength(1);
    expect(result!.citations[0].vaultRefs).toEqual([
      "document-a.md",
      "test-document.md",
      "document-b.md",
    ]);
  });

  it("should handle database errors gracefully", async () => {
    // Create a mock database that throws errors
    const mockDb = {
      prepare: () => ({
        all: () => {
          throw new Error("Database error");
        },
        get: () => {
          throw new Error("Database error");
        },
      }),
    } as unknown as Database;

    const result = await getProvenance("018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", "test-document.md", mockDb);
    
    // Should return null on error
    expect(result).toBeNull();
  });

  it("should calculate stale risk correctly", async () => {
    // Create a test episode first
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO episodes (id, tenant_id, summary, started_at, ended_at, duration_sec, lifecycle, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-episode-stale",
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "Test document content",
      now,
      now,
      60,
      "active",
      now
    );

    // Insert test action log with old date (more than 30 days ago)
    const actionId = "test-action-stale";
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 31); // 31 days ago
    const loggedAt = oldDate.toISOString();
    const vaultRefs = JSON.stringify(["test-document.md"]);
    
    sqlite.prepare(`
      INSERT INTO action_log (
        id, tenant_id, actor_id, actor_type, actor_label, action_kind,
        payload_snapshot, vault_refs, conversation_refs, project_refs,
        proposed_at, logged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actionId,
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "test-agent-1",
      "agent",
      "Test Agent",
      "memory.read",
      "{}",
      vaultRefs,
      "[]",
      "[]",
      loggedAt,
      loggedAt
    );

    const result = await getProvenance("018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", "test-document.md");
    
    expect(result).not.toBeNull();
    expect(result!.citations).toHaveLength(1);
    expect(result!.staleRisk).toBe(true); // Document has citations (importance >= 3) and is old (31 days)
  });

  it("should not mark recent documents as stale", async () => {
    // Create a test episode first
    const now = new Date().toISOString();
    sqlite.prepare(`
      INSERT INTO episodes (id, tenant_id, summary, started_at, ended_at, duration_sec, lifecycle, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "test-episode-recent",
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "Test document content",
      now,
      now,
      60,
      "active",
      now
    );

    // Insert test action log with recent date (less than 30 days ago)
    const actionId = "test-action-recent";
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 15); // 15 days ago
    const loggedAt = recentDate.toISOString();
    const vaultRefs = JSON.stringify(["test-document.md"]);
    
    sqlite.prepare(`
      INSERT INTO action_log (
        id, tenant_id, actor_id, actor_type, actor_label, action_kind,
        payload_snapshot, vault_refs, conversation_refs, project_refs,
        proposed_at, logged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      actionId,
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "test-agent-1",
      "agent",
      "Test Agent",
      "memory.read",
      "{}",
      vaultRefs,
      "[]",
      "[]",
      loggedAt,
      loggedAt
    );

    const result = await getProvenance("018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", "test-document.md");
    
    expect(result).not.toBeNull();
    expect(result!.citations).toHaveLength(1);
    expect(result!.staleRisk).toBe(false); // Document has citations but is recent (15 days)
  });
});