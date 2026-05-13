/**
 * Integration test demonstrating action-log helpers usage for morning brief
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSqlite, initDb, resetDb } from "../db/index.js";
import { randomUUID } from "node:crypto";
import { actionLogSince, countActionLogSince, getActionLogSummaryByKind } from "./action-log-query.js";
import { migrate } from "../db/migrations/index.js";
import type { Config } from "../config.js";

const TENANT_1 = "11111111-1111-1111-1111-111111111111";
const AGENT_1 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const AGENT_2 = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

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

describe("action-log-query integration for morning brief", () => {
  beforeEach(() => {
    resetDb();
    dataDir = mkdtempSync(join(tmpdir(), "awo-action-log-integ-"));
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
    payloadSnapshot?: Record<string, unknown>;
  }) {
    const now = new Date().toISOString();
    getSqlite().prepare(`
      INSERT INTO action_log (
        id, tenant_id, actor_id, actor_type, actor_label, action_kind,
        payload_snapshot, vault_refs, conversation_refs, project_refs,
        policy_decision_id, proposed_at, logged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', NULL, ?, ?)
    `).run(
      randomUUID(),
      params.tenantId,
      params.actorId,
      params.actorType,
      params.actorLabel,
      params.actionKind,
      JSON.stringify(params.payloadSnapshot || {}),
      params.proposedAt || now,
      params.loggedAt
    );
  }

  it("can generate morning brief summary statistics", () => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();

    // Simulate a morning's worth of activity
    
    // Policy decisions: 2 blocked, 3 routed to review, 10 allowed
    for (let i = 0; i < 2; i++) {
      insertActionLog({
        tenantId: TENANT_1,
        actorId: AGENT_1,
        actorType: "agent",
        actorLabel: "Sales Agent",
        actionKind: "policy.check",
        loggedAt: oneHourAgo,
        payloadSnapshot: { decision: "block", reason: "compliance_violation" },
      });
    }

    for (let i = 0; i < 3; i++) {
      insertActionLog({
        tenantId: TENANT_1,
        actorId: AGENT_2,
        actorType: "agent",
        actorLabel: "Marketing Agent",
        actionKind: "policy.check",
        loggedAt: twoHoursAgo,
        payloadSnapshot: { decision: "route_to_review", reason: "needs_approval" },
      });
    }

    for (let i = 0; i < 10; i++) {
      insertActionLog({
        tenantId: TENANT_1,
        actorId: AGENT_1,
        actorType: "agent",
        actorLabel: "Sales Agent",
        actionKind: "policy.check",
        loggedAt: threeHoursAgo,
        payloadSnapshot: { decision: "allow" },
      });
    }

    // Agent wakeups and other activities
    for (let i = 0; i < 5; i++) {
      insertActionLog({
        tenantId: TENANT_1,
        actorId: AGENT_1,
        actorType: "agent",
        actorLabel: "Sales Agent",
        actionKind: "agent.wakeup",
        loggedAt: twoHoursAgo,
      });
    }

    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_2,
      actorType: "agent",
      actorLabel: "Marketing Agent",
      actionKind: "issue.update",
      loggedAt: oneHourAgo,
    });

    // Query for the last 24 hours
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    // Get total action count
    const totalActions = countActionLogSince(TENANT_1, cutoff);
    expect(totalActions).toBe(21); // 2+3+10+5+1 = 21

    // Get summary by action kind
    const summaryByKind = getActionLogSummaryByKind(TENANT_1, cutoff);
    
    const policyChecks = summaryByKind.find(s => s.actionKind === "policy.check");
    const agentWakeups = summaryByKind.find(s => s.actionKind === "agent.wakeup");
    const issueUpdates = summaryByKind.find(s => s.actionKind === "issue.update");

    expect(policyChecks?.count).toBe(15); // 2+3+10 = 15
    expect(agentWakeups?.count).toBe(5);
    expect(issueUpdates?.count).toBe(1);

    // Get detailed action logs for policy checks to analyze decisions
    const policyActions = actionLogSince(TENANT_1, cutoff, { actionKind: "policy.check" });
    expect(policyActions).toHaveLength(15);

    // Count decisions by analyzing payload snapshots
    let blockedCount = 0;
    let routedCount = 0;
    let allowedCount = 0;

    for (const action of policyActions) {
      const payload = action.payloadSnapshot as any;
      if (payload.decision === "block") blockedCount++;
      else if (payload.decision === "route_to_review") routedCount++;
      else if (payload.decision === "allow") allowedCount++;
    }

    expect(blockedCount).toBe(2);
    expect(routedCount).toBe(3);
    expect(allowedCount).toBe(10);
  });

  it("can filter actions by specific agents", () => {
    const now = new Date().toISOString();

    // Agent 1 activities
    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Sales Agent",
      actionKind: "policy.check",
      loggedAt: now,
    });

    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Sales Agent",
      actionKind: "agent.wakeup",
      loggedAt: now,
    });

    // Agent 2 activities
    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_2,
      actorType: "agent",
      actorLabel: "Marketing Agent",
      actionKind: "policy.check",
      loggedAt: now,
    });

    const cutoff = new Date(new Date().getTime() - 24 * 60 * 60 * 1000).toISOString();

    // Get actions for specific agent
    const agent1Actions = actionLogSince(TENANT_1, cutoff, { actorId: AGENT_1 });
    expect(agent1Actions).toHaveLength(2);

    const agent2Actions = actionLogSince(TENANT_1, cutoff, { actorId: AGENT_2 });
    expect(agent2Actions).toHaveLength(1);

    // Count actions by agent
    const agent1Count = countActionLogSince(TENANT_1, cutoff, { actorId: AGENT_1 });
    expect(agent1Count).toBe(2);

    const agent2Count = countActionLogSince(TENANT_1, cutoff, { actorId: AGENT_2 });
    expect(agent2Count).toBe(1);
  });

  it("can handle time-windowed queries for morning brief", () => {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();

    // Old actions (should not be included)
    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Sales Agent",
      actionKind: "policy.check",
      loggedAt: twoDaysAgo,
    });

    // Recent actions (should be included)
    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_1,
      actorType: "agent",
      actorLabel: "Sales Agent",
      actionKind: "policy.check",
      loggedAt: yesterday,
    });

    insertActionLog({
      tenantId: TENANT_1,
      actorId: AGENT_2,
      actorType: "agent",
      actorLabel: "Marketing Agent",
      actionKind: "agent.wakeup",
      loggedAt: yesterday,
    });

    // Query for last 24 hours
    const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const recentActions = actionLogSince(TENANT_1, cutoff);

    expect(recentActions).toHaveLength(2);
    expect(recentActions.every(action => new Date(action.loggedAt) >= new Date(cutoff))).toBe(true);
  });
});