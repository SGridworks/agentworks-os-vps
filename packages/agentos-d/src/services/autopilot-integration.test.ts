import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations/index.js";
import { AutopilotService } from "./autopilot.js";
import { DispatchConsumer, type AgentAdapter } from "./dispatch-consumer.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

let sqlite: Database.Database;

function seedAgent(id: string, status = "active"): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO execution_companies (id, tenant_id, name, status, metadata_json, source, created_at, updated_at)
       VALUES (?, ?, 'Co', 'active', '{}', 'awos', ?, ?)`
    )
    .run(COMPANY, TENANT, now, now);
  sqlite
    .prepare(
      `INSERT INTO execution_agents
         (id, tenant_id, company_id, name, role, status, config_json, model, created_at, updated_at)
       VALUES (?, ?, ?, 'A', 'BackendEngineer', ?, '{}', 'kimi-k2', ?, ?)`
    )
    .run(id, TENANT, COMPANY, status, now, now);
}

function seedPolicyDecision(
  id: string,
  decision: "allow" | "block" | "route_to_review",
  rulePackId = "smb-starter"
): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO policy_decisions (
        id, action_id, tenant_id, actor_id, actor_type, actor_label,
        proposed_action_kind, proposed_action_summary, decision, decision_reason,
        evidence_snapshot, decision_hash, proposed_at, decided_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'agent', 'TestAgent', 'test.action', 'test summary', ?, 'test reason',
        '{}', 'hash', ?, ?, ?, ?)`
    )
    .run(id, id, TENANT, TENANT, decision, now, now, now, now);
}

function enqueueWithRisk(
  id: string,
  taskKind: string,
  policyDecisionId: string | null,
  riskData: {
    riskScore: number;
    reasons: string[];
    autopilotDecision: "allow" | "needsApproval" | "risky";
  },
  additionalInput: Record<string, unknown> = {}
): void {
  const now = new Date().toISOString();
  const input = {
    ...additionalInput,
    ...riskData,
  };
  sqlite
    .prepare(
      `INSERT INTO dispatch_queue
         (id, tenant_id, task_kind, target_agent_id, input, status, created_at, policy_decision_id)
       VALUES (?, ?, ?, 'agent-123', ?, 'queued', ?, ?)`
    )
    .run(id, TENANT, taskKind, JSON.stringify(input), now, policyDecisionId);
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  migrate(sqlite);
});

describe("Autopilot + DispatchConsumer integration", () => {
  it("autopilot stamps risk into dispatch, consumer reads it", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    
    const policyId = "policy-123";
    seedPolicyDecision(policyId, "allow", "smb-starter");
    
    const dispatchId = "dispatch-123";
    
    // First, create a simple dispatch without risk data
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO dispatch_queue
           (id, tenant_id, task_kind, target_agent_id, input, status, created_at, policy_decision_id)
         VALUES (?, ?, ?, ?, '{}', 'queued', ?, ?)`
      )
      .run(dispatchId, TENANT, "memory_write", agentId, now, policyId);
    
    // Process the dispatch through autopilot
    const autopilot = new AutopilotService(sqlite);
    const evaluation = autopilot.processDispatch(dispatchId);
    
    expect(evaluation.riskScore).toBe(0.1);
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.reasons).toEqual([]);
    
    // Now process through dispatch consumer
    let capturedInput: any | undefined;
    const capturingAdapter: AgentAdapter = {
      async run(input) {
        capturedInput = input;
        return { status: "completed" };
      },
    };
    
    const consumer = new DispatchConsumer({ sqlite, adapter: capturingAdapter });
    const result = await consumer.tick();
    
    expect(result.completed).toBe(1);
    expect(capturedInput).toBeDefined();
    expect(capturedInput!.riskScore).toBe(0.1);
    expect(capturedInput!.autopilotDecision).toBe("allow");
    expect(capturedInput!.reasons).toEqual([]);
  });

  it("handles high-risk actions correctly", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    
    const policyId = "policy-123";
    seedPolicyDecision(policyId, "route_to_review", "tcpa-real-estate");
    
    const dispatchId = "dispatch-high-risk";
    
    // Create a dispatch for SMS action (high risk)
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO dispatch_queue
           (id, tenant_id, task_kind, target_agent_id, input, status, created_at, policy_decision_id)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`
      )
      .run(dispatchId, TENANT, "sms_send", agentId, JSON.stringify({
        hasFairHousingKeywords: true,
        message: "Special housing offer for families",
      }), now, policyId);
    
    // Process through autopilot
    const autopilot = new AutopilotService(sqlite);
    const evaluation = autopilot.processDispatch(dispatchId);
    
    expect(evaluation.riskScore).toBeGreaterThan(0.5);
    expect(evaluation.decision).toBe("needsApproval");
    expect(evaluation.reasons).toContain("action_type.high_risk");
    
    // Process through dispatch consumer
    let capturedInput: any | undefined;
    const capturingAdapter: AgentAdapter = {
      async run(input) {
        capturedInput = input;
        return { status: "completed" };
      },
    };
    
    const consumer = new DispatchConsumer({ sqlite, adapter: capturingAdapter });
    const result = await consumer.tick();
    
    expect(result.completed).toBe(1);
    expect(capturedInput).toBeDefined();
    expect(capturedInput!.riskScore).toBeGreaterThan(0.5);
    expect(capturedInput!.autopilotDecision).toBe("needsApproval");
    expect(capturedInput!.reasons).toContain("action_type.high_risk");
  });

  it("blocks actions when policy decision is block", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    
    const policyId = "policy-block";
    seedPolicyDecision(policyId, "block", "tcpa-real-estate");
    
    const dispatchId = "dispatch-blocked";
    
    // Create a dispatch with block policy decision
    const now = new Date().toISOString();
    sqlite
      .prepare(
        `INSERT INTO dispatch_queue
           (id, tenant_id, task_kind, target_agent_id, input, status, created_at, policy_decision_id)
         VALUES (?, ?, ?, ?, '{}', 'queued', ?, ?)`
      )
      .run(dispatchId, TENANT, "sms_send", agentId, now, policyId);
    
    // Process through autopilot
    const autopilot = new AutopilotService(sqlite);
    const evaluation = autopilot.processDispatch(dispatchId);
    
    expect(evaluation.riskScore).toBe(1.0);
    expect(evaluation.decision).toBe("risky");
    expect(evaluation.reasons).toContain("rule_pack.block");
    
    // Process through dispatch consumer
    let capturedInput: any | undefined;
    const capturingAdapter: AgentAdapter = {
      async run(input) {
        capturedInput = input;
        return { status: "completed" };
      },
    };
    
    const consumer = new DispatchConsumer({ sqlite, adapter: capturingAdapter });
    const result = await consumer.tick();
    
    expect(result.completed).toBe(1);
    expect(capturedInput).toBeDefined();
    expect(capturedInput!.riskScore).toBe(1.0);
    expect(capturedInput!.autopilotDecision).toBe("risky");
    expect(capturedInput!.reasons).toContain("rule_pack.block");
  });

  it("preserves existing input data while adding risk information", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    
    const policyId = "policy-123";
    seedPolicyDecision(policyId, "allow", "smb-starter");
    
    const dispatchId = "dispatch-preserve";
    
    // Create a dispatch with existing data
    const now = new Date().toISOString();
    const existingData = {
      existingField: "preserved value",
      nested: { data: "should be kept" },
      array: [1, 2, 3],
    };
    sqlite
      .prepare(
        `INSERT INTO dispatch_queue
           (id, tenant_id, task_kind, target_agent_id, input, status, created_at, policy_decision_id)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`
      )
      .run(dispatchId, TENANT, "memory_write", agentId, JSON.stringify(existingData), now, policyId);
    
    // Process through autopilot
    const autopilot = new AutopilotService(sqlite);
    const evaluation = autopilot.processDispatch(dispatchId);
    
    expect(evaluation.riskScore).toBe(0.1);
    expect(evaluation.decision).toBe("allow");
    
    // Process through dispatch consumer
    let capturedInput: any | undefined;
    const capturingAdapter: AgentAdapter = {
      async run(input) {
        capturedInput = input;
        return { status: "completed" };
      },
    };
    
    const consumer = new DispatchConsumer({ sqlite, adapter: capturingAdapter });
    const result = await consumer.tick();
    
    expect(result.completed).toBe(1);
    expect(capturedInput).toBeDefined();
    expect(capturedInput!.payload).toMatchObject({
      existingField: "preserved value",
      nested: { data: "should be kept" },
      array: [1, 2, 3],
      riskScore: 0.1,
      reasons: [],
      autopilotDecision: "allow",
    });
  });
});