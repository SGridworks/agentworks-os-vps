/**
 * hot-md-builder tests.
 *
 * - rebuild produces deterministic content given fixed inputs
 * - truncates content over 500 words
 * - updates atomically (write via vault store = .tmp + rename)
 * - excludes hot.md itself from vault key list
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, resetDb, getDb } from "../db/client.js";
import { migrate } from "../db/migrations/index.js";
import { tenants, policyDecisions, approvalQueue } from "../db/schema.js";
import { FileVaultStore } from "@agentworks/memory";
import { rebuildHotMd } from "./hot-md-builder.js";
import type { RulePack } from "@agentworks/shared";

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

let dataDir: string;
let vaultDir: string;

function baseConfig(dir: string) {
  return {
    host: "127.0.0.1",
    port: 0,
    logLevel: "warn" as const,
    awcpVersion: "awcp/v0.1",
    dataDir: dir,
    scannerSidecarUrl: "http://127.0.0.1:0",
    scannerPollIntervalMs: 30_000,
    auditLogRetentionDays: 30,
  };
}

function seedTenant(name: string) {
  const db = getDb();
  db.insert(tenants)
    .values({
      id: TENANT_ID,
      name,
      description: "test tenant",
      industry: "healthcare",
      vaultRoot: "<default>",
      shadowMode: true,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    })
    .run();
}

function seedDecisions(count: number) {
  const db = getDb();
  for (let i = 0; i < count; i++) {
    db.insert(policyDecisions)
      .values({
        id: `dec-${i}`,
        actionId: `act-${i}`,
        tenantId: TENANT_ID,
        actorId: "agent-1",
        actorType: "agent",
        actorLabel: "TestAgent",
        proposedActionKind: "sms",
        proposedActionSummary: "send reminder",
        evidenceSnapshot: "{}",
        decision: i % 3 === 0 ? "allow" : i % 3 === 1 ? "block" : "route_to_review",
        decisionReason: "rule evaluation",
        shadowMode: false,
        proposedAt: new Date(Date.now() - i * 60000).toISOString(),
        decidedAt: new Date(Date.now() - i * 60000).toISOString(),
        createdAt: new Date(Date.now() - i * 60000).toISOString(),
        updatedAt: new Date(Date.now() - i * 60000).toISOString(),
        decisionHash: `hash-${i}`,
      })
      .run();
  }
}

function seedApproval(createdMinutesAgo: number, status: "pending" | "approved" = "pending") {
  const db = getDb();
  db.insert(approvalQueue)
    .values({
      id: `appr-${createdMinutesAgo}`,
      policyDecisionId: `dec-${createdMinutesAgo}`,
      tenantId: TENANT_ID,
      actorLabel: "AgentX",
      proposedActionKind: "email",
      proposedActionSummary: "newsletter",
      decisionReason: "needs review",
      status,
      createdAt: new Date(Date.now() - createdMinutesAgo * 60000).toISOString(),
      updatedAt: new Date(Date.now() - createdMinutesAgo * 60000).toISOString(),
    })
    .run();
}

describe("rebuildHotMd", () => {
  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-hot-md-"));
    vaultDir = mkdtempSync(join(tmpdir(), "awo-hot-vault-"));
    initDb({ config: baseConfig(dataDir), migrations: migrate });
  });
  afterEach(() => {
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it("produces deterministic content given fixed inputs", async () => {
    seedTenant("Acme Corp");
    seedDecisions(3);
    const vault = new FileVaultStore({ root: vaultDir });
    await vault.write(TENANT_ID, "projects/acme", "# Acme Project\nDetails here.");

    const result1 = await rebuildHotMd({
      db: getDb(),
      vault,
      tenantId: TENANT_ID,
      packs: [],
    });
    const r1 = await vault.read(TENANT_ID, "hot");

    const result2 = await rebuildHotMd({
      db: getDb(),
      vault,
      tenantId: TENANT_ID,
      packs: [],
    });
    const r2 = await vault.read(TENANT_ID, "hot");

    expect(result1.words).toBe(result2.words);
    expect(r1.body).toBe(r2.body);
    expect(r1.existed).toBe(true);
  });

  it("truncates content over 500 words", async () => {
    seedTenant("Big Corp");
    // Generate many decisions and vault keys to push word count over 500
    seedDecisions(80);
    for (let i = 0; i < 15; i++) {
      seedApproval(i, "pending");
    }
    const vault = new FileVaultStore({ root: vaultDir });
    for (let i = 0; i < 200; i++) {
      await vault.write(TENANT_ID, `doc-${i}`, `This is a fairly long summary line for document number ${i} that contains many words to inflate the total word count beyond the five hundred word limit we are testing in this specific test case scenario.`);
    }

    const result = await rebuildHotMd({
      db: getDb(),
      vault,
      tenantId: TENANT_ID,
      packs: [],
    });

    expect(result.words).toBeLessThanOrEqual(500);
    const r = await vault.read(TENANT_ID, "hot");
    expect(r.body).toContain("_(truncated)_");
  });

  it("excludes hot.md itself from vault key list", async () => {
    seedTenant("Selfless Corp");
    const vault = new FileVaultStore({ root: vaultDir });
    await vault.write(TENANT_ID, "hot", "this is pre-existing hot.md");
    await vault.write(TENANT_ID, "readme", "# Readme\nHello.");

    await rebuildHotMd({
      db: getDb(),
      vault,
      tenantId: TENANT_ID,
      packs: [],
    });

    const r = await vault.read(TENANT_ID, "hot");
    expect(r.body).not.toContain("this is pre-existing hot.md");
    expect(r.body).toContain("readme");
  });

  it("surfaces tenant identity, decisions, approvals, and rule packs", async () => {
    seedTenant("Multi Corp");
    seedDecisions(2);
    seedApproval(30, "pending");
    seedApproval(10, "approved");

    const pack: RulePack = {
      pack_id: "tcpa-v1",
      version: "1.0.0",
      rules: [],
      meta: { author: "test", created_at: "2026-01-01", jurisdiction: "US" },
    };

    const vault = new FileVaultStore({ root: vaultDir });
    await vault.write(TENANT_ID, "notes/today", "# Daily notes\nStandup at 9.");

    await rebuildHotMd({
      db: getDb(),
      vault,
      tenantId: TENANT_ID,
      packs: [pack],
    });

    const r = await vault.read(TENANT_ID, "hot");
    expect(r.body).toContain("Multi Corp");
    expect(r.body).toContain("11111111-1111-1111-1111-111111111111");
    expect(r.body).toContain("[allow]");
    expect(r.body).toContain("Open:** 1");
    expect(r.body).toContain("tcpa-v1");
    expect(r.body).toContain("notes/today");
    expect(r.body).toContain("Daily notes");
  });
});
