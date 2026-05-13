import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSqlite, initDb, resetDb } from "../db/index.js";
import { randomUUID } from "node:crypto";
import { actionLogSince, countActionLogSince, getDistinctActionKindsSince, getActionLogSummaryByKind } from "./action-log-query.js";
import { migrate } from "../db/migrations/index.js";
import type { Config } from "../config.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const TENANT_2 = "22222222-2222-2222-2222-222222222222";
const AGENT_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

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

describe("action-log-query helpers", () => {
  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-action-log-"));
    initDb({ config: config(), migrations: migrate });
  });

  afterEach(() => {
    resetDb();
    rmSync(dataDir, { recursive: true, force: true });
  });

  function insertActionLog(params: {
    tenantId: string;
    actorId: string;
    actorType: "human" | "agent" | "system";
    actorLabel: string;
    actionKind: string;
    loggedAt: string;
  }) {
    const now = new Date().toISOString();
    getSqlite().prepare(`
      INSERT INTO action_log (
        id, tenant_id, actor_id, actor_type, actor_label, action_kind,
        payload_snapshot, vault_refs, conversation_refs, project_refs,
        policy_decision_id, proposed_at, logged_at
      ) VALUES (?, ?, ?, ?, ?, ?, '{}', '[]', '[]', '[]', NULL, ?, ?)
    `).run(
      randomUUID(),
      params.tenantId,
      params.actorId,
      params.actorType,
      params.actorLabel,
      params.actionKind,
      params.proposedAt || now,
      params.loggedAt
    );
  }

  it("actionLogSince returns actions since timestamp", () => {
    const now = new Date().toISOString();
    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Test Agent",
      actionKind: "policy.check",
      loggedAt: now,
    });

    const results = actionLogSince(TENANT_1, now);
    expect(results).toHaveLength(1);
    expect(results[0].tenantId).toBe(TENANT_1);
    expect(results[0].actionKind).toBe("policy.check");
  });

  it("actionLogSince filters by action kind", () => {
    const now = new Date().toISOString();
    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Test Agent",
      actionKind: "policy.check",
      loggedAt: now,
    });

    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Test Agent",
      actionKind: "agent.wakeup",
      loggedAt: now,
    });

    const results = actionLogSince(TENANT_1, now, { actionKind: "policy.check" });
    expect(results).toHaveLength(1);
    expect(results[0].actionKind).toBe("policy.check");
  });

  it("countActionLogSince returns correct count", () => {
    const now = new Date().toISOString();
    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Test Agent",
      actionKind: "policy.check",
      loggedAt: now,
    });

    const count = countActionLogSince(TENANT_1, now);
    expect(count).toBe(1);
  });

  it("getDistinctActionKindsSince returns unique kinds", () => {
    const now = new Date().toISOString();
    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Test Agent",
      actionKind: "policy.check",
      loggedAt: now,
    });

    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Test Agent",
      actionKind: "agent.wakeup",
      loggedAt: now,
    });

    const kinds = getDistinctActionKindsSince(TENANT_1, now);
    expect(kinds).toHaveLength(2);
    expect(kinds).toContain("policy.check");
    expect(kinds).toContain("agent.wakeup");
  });

  it("getActionLogSummaryByKind returns grouped counts", () => {
    const now = new Date().toISOString();
    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Test Agent",
      actionKind: "policy.check",
      loggedAt: now,
    });

    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Test Agent",
      actionKind: "policy.check",
      loggedAt: now,
    });

    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Test Agent",
      actionKind: "agent.wakeup",
      loggedAt: now,
    });

    const summary = getActionLogSummaryByKind(TENANT_1, now);
    expect(summary).toHaveLength(2);
    
    const policyCheck = summary.find(s => s.actionKind === "policy.check");
    const agentWakeup = summary.find(s => s.actionKind === "agent.wakeup");
    
    expect(policyCheck?.count).toBe(2);
    expect(agentWakeup?.count).toBe(1);
  });
});