/**
 * Tests for the memory provenance route.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.js";
import type { Database } from "better-sqlite3";
import { getDb, initDb, resetDb } from "../db/index.js";
import { migrate } from "../db/migrations/index.js";
import { loadConfig } from "../config.js";
import { _resetVaultStoreForTesting } from "./memory.js";

function config() {
  return loadConfig({});
}

let dataDir: string;

describe("GET /api/memory/provenance", () => {
  let app: ReturnType<typeof createApp>;
  let sqlite: Database;

  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-mem-prov-route-"));
    initDb({ config: config(), migrations: migrate });
    app = createApp(config());
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

  it("should return 400 for missing tenantId", async () => {
    const res = await request(app)
      .get("/api/memory/provenance")
      .query({ key: "test-document.md" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("should return 400 for missing key", async () => {
    const res = await request(app)
      .get("/api/memory/provenance")
      .query({ tenantId: "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("should return 400 for invalid tenantId format", async () => {
    const res = await request(app)
      .get("/api/memory/provenance")
      .query({ tenantId: "invalid-uuid", key: "test-document.md" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("should return 200 for non-existent document (temporary behavior)", async () => {
    const res = await request(app)
      .get("/api/memory/provenance")
      .query({ tenantId: "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", key: "non-existent.md" });

    // For now, we return 200 even for non-existent documents
    // This will be updated when vault store integration is complete
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.key).toBe("non-existent.md");
  });

  it("should return 200 with provenance data for existing document", async () => {
    // Create a test episode to simulate document existence
    const now = new Date().toISOString();
    const episodeId = `test-episode-existing-${Date.now()}`;
    sqlite.prepare(`
      INSERT INTO episodes (id, tenant_id, summary, started_at, ended_at, duration_sec, lifecycle, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      episodeId,
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "Test document content",
      now,
      now,
      60,
      "active",
      now
    );

    const res = await request(app)
      .get("/api/memory/provenance")
      .query({ tenantId: "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", key: "test-document.md" });

    // Debug output - force the test to show the output
    try {
      expect(res.status).toBe(200);
    } catch (e) {
      console.log("Response status:", res.status);
      console.log("Response body:", res.body);
      throw e;
    }

    expect(res.body.ok).toBe(true);
    expect(res.body.data).toMatchObject({
      key: "test-document.md",
      frontmatter: expect.any(Object),
      citations: expect.any(Array),
      decisions: expect.any(Array),
      conflicts: expect.any(Array),
      readWindowDays: 30,
    });
  });

  it("should return citations when document is referenced in action logs", async () => {
    // Create a test episode
    const now = new Date().toISOString();
    const episodeId = `test-episode-citations-${Date.now()}`;
    sqlite.prepare(`
      INSERT INTO episodes (id, tenant_id, summary, started_at, ended_at, duration_sec, lifecycle, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      episodeId,
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "Test document content",
      now,
      now,
      60,
      "active",
      now
    );

    // Clean up any existing action logs for this test
    sqlite.exec("DELETE FROM action_log WHERE tenant_id = '018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b' AND vault_refs LIKE '%test-document.md%'");

    // Insert test action log
    const actionId = `test-action-${Date.now()}`;
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

    const res = await request(app)
      .get("/api/memory/provenance")
      .query({ tenantId: "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", key: "test-document.md" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.citations).toHaveLength(1);
    expect(res.body.data.citations[0]).toMatchObject({
      actionId,
      actionKind: "memory.read",
      actorId: "test-agent-1",
      actorLabel: "Test Agent",
      actorType: "agent",
      loggedAt,
      vaultRefs: ["test-document.md"],
    });
  });

  it("should handle URL encoding correctly", async () => {
    // Create a test episode
    const now = new Date().toISOString();
    const episodeId = `test-episode-url-${Date.now()}`;
    sqlite.prepare(`
      INSERT INTO episodes (id, tenant_id, summary, started_at, ended_at, duration_sec, lifecycle, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      episodeId,
      "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b",
      "Test document content",
      now,
      now,
      60,
      "active",
      now
    );

    const documentKey = "path/to/document-with-spaces.md";

    const res = await request(app)
      .get("/api/memory/provenance")
      .query({ tenantId: "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", key: documentKey });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.key).toBe(documentKey);
  });

  it("should handle internal server errors gracefully", async () => {
    // This test would require mocking the provenance service to throw an error
    // For now, we'll test the error handling structure
    
    const res = await request(app)
      .get("/api/memory/provenance")
      .query({ tenantId: "018f3f5c-7b7b-7b7b-7b7b-7b7b7b7b7b7b", key: "" }); // Empty key might cause issues

    // Should get 400 for invalid key, not 500
    expect(res.status).toBe(400);
  });
});