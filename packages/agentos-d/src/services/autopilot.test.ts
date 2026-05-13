import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations/index.js";
import { AutopilotService } from "./autopilot.js";

const TENANT = "11111111-1111-1111-1111-111111111111";

let sqlite: Database.Database;

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

function seedDispatch(
  id: string,
  taskKind: string,
  policyDecisionId: string | null,
  input: Record<string, unknown> = {}
): void {
  const now = new Date().toISOString();
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

describe("AutopilotService.evaluateAction", () => {
  it("allows safe actions with low risk score", () => {
    const service = new AutopilotService(sqlite);
    
    const evaluation = service.evaluateAction("memory_write", {
      decision: "allow",
      rulePackId: "smb-starter",
    });

    expect(evaluation.riskScore).toBe(0.1);
    expect(evaluation.reasons).toEqual([]);
    expect(evaluation.decision).toBe("allow");
  });

  it("blocks actions when policy decision is block", () => {
    const service = new AutopilotService(sqlite);
    
    const evaluation = service.evaluateAction("sms_send", {
      decision: "block",
      rulePackId: "tcpa-real-estate",
    });

    expect(evaluation.riskScore).toBe(1.0);
    expect(evaluation.reasons).toContain("rule_pack.block");
    expect(evaluation.decision).toBe("risky");
  });

  it("routes medium risk actions to approval", () => {
    const service = new AutopilotService(sqlite);
    
    const evaluation = service.evaluateAction("email_send", {
      decision: "route_to_review",
      rulePackId: "smb-starter",
    });

    expect(evaluation.riskScore).toBe(0.45);
    expect(evaluation.decision).toBe("needsApproval");
  });

  it("detects fair housing keyword risk", () => {
    const service = new AutopilotService(sqlite);
    
    const evaluation = service.evaluateAction("memory_write", {
      decision: "allow",
      rulePackId: "fair-housing",
    }, {
      hasFairHousingKeywords: true,
    });

    expect(evaluation.riskScore).toBe(0.3);
    expect(evaluation.reasons).toContain("fair_housing.keyword_match");
    expect(evaluation.decision).toBe("needsApproval");
  });

  it("detects high confidence PII risk", () => {
    const service = new AutopilotService(sqlite);
    
    const evaluation = service.evaluateAction("memory_write", {
      decision: "allow",
      rulePackId: "smb-starter",
    }, {
      hasHighConfidencePii: true,
    });

    expect(evaluation.riskScore).toBe(1.0);
    expect(evaluation.reasons).toContain("pii.high_confidence");
    expect(evaluation.decision).toBe("risky");
  });

  it("detects high risk action types", () => {
    const service = new AutopilotService(sqlite);
    
    const evaluation = service.evaluateAction("sms_send", {
      decision: "allow",
      rulePackId: "smb-starter",
    });

    expect(evaluation.riskScore).toBe(0.55);
    expect(evaluation.reasons).toContain("action_type.high_risk");
    expect(evaluation.decision).toBe("needsApproval");
  });

  it("handles multiple risk factors", () => {
    const service = new AutopilotService(sqlite);
    
    const evaluation = service.evaluateAction("sms_send", {
      decision: "route_to_review",
      rulePackId: "tcpa-real-estate",
    }, {
      hasTcpaViolations: true,
      hasFairHousingKeywords: true,
    });

    expect(evaluation.riskScore).toBe(0.55);
    expect(evaluation.reasons).toContain("fair_housing.keyword_match");
    expect(evaluation.reasons).toContain("action_type.high_risk");
    expect(evaluation.decision).toBe("needsApproval");
  });

  it("caps reasons at 5 items", () => {
    const service = new AutopilotService(sqlite);
    
    const evaluation = service.evaluateAction("sms_send", {
      decision: "allow",
      rulePackId: "smb-starter",
    }, {
      hasFairHousingKeywords: true,
      hasTcpaViolations: true,
      hasPhi: true,
      hasHighConfidencePii: true,
      hasUnsafeUrl: true,
      recentDenial: true,
    });

    expect(evaluation.reasons.length).toBeLessThanOrEqual(5);
  });

  it("deduplicates repeated reasons", () => {
    const service = new AutopilotService(sqlite);
    
    const evaluation = service.evaluateAction("sms_send", {
      decision: "block",
      rulePackId: "tcpa-real-estate",
    }, {
      hasHighConfidencePii: true,
    });

    const piiReasons = evaluation.reasons.filter(r => r === "pii.high_confidence");
    expect(piiReasons.length).toBe(1);
  });
});

describe("AutopilotService.stampRiskIntoDispatch", () => {
  it("stamps risk evaluation into dispatch queue input", () => {
    const service = new AutopilotService(sqlite);
    const dispatchId = "dispatch-123";
    
    seedDispatch(dispatchId, "memory_write", null, { existing: "data" });

    const evaluation = {
      riskScore: 0.25,
      reasons: ["test.reason"],
      decision: "allow" as const,
    };

    service.stampRiskIntoDispatch(dispatchId, evaluation);

    const row = sqlite
      .prepare("SELECT input FROM dispatch_queue WHERE id = ?")
      .get(dispatchId) as { input: string };

    const input = JSON.parse(row.input);
    expect(input.riskScore).toBe(0.25);
    expect(input.reasons).toEqual(["test.reason"]);
    expect(input.autopilotDecision).toBe("allow");
    expect(input.existing).toBe("data"); // Preserves existing data
  });

  it("handles invalid JSON in existing input", () => {
    const service = new AutopilotService(sqlite);
    const dispatchId = "dispatch-123";
    
    sqlite
      .prepare(
        `INSERT INTO dispatch_queue
           (id, tenant_id, task_kind, target_agent_id, input, status, created_at)
         VALUES (?, ?, ?, 'agent-123', 'invalid json', 'queued', ?)`
      )
      .run(dispatchId, TENANT, "memory_write", new Date().toISOString());

    const evaluation = {
      riskScore: 0.5,
      reasons: ["test.reason"],
      decision: "needsApproval" as const,
    };

    service.stampRiskIntoDispatch(dispatchId, evaluation);

    const row = sqlite
      .prepare("SELECT input FROM dispatch_queue WHERE id = ?")
      .get(dispatchId) as { input: string };

    const input = JSON.parse(row.input);
    expect(input.riskScore).toBe(0.5);
    expect(input.reasons).toEqual(["test.reason"]);
    expect(input.autopilotDecision).toBe("needsApproval");
  });

  it("throws error for non-existent dispatch", () => {
    const service = new AutopilotService(sqlite);
    
    const evaluation = {
      riskScore: 0.5,
      reasons: ["test.reason"],
      decision: "needsApproval" as const,
    };

    expect(() => {
      service.stampRiskIntoDispatch("non-existent", evaluation);
    }).toThrow("Dispatch non-existent not found");
  });
});

describe("AutopilotService.processDispatch", () => {
  it("processes dispatch with policy decision", () => {
    const service = new AutopilotService(sqlite);
    const dispatchId = "dispatch-123";
    const policyId = "policy-123";
    
    seedPolicyDecision(policyId, "allow", "smb-starter");
    seedDispatch(dispatchId, "memory_write", policyId);

    const evaluation = service.processDispatch(dispatchId);

    expect(evaluation.riskScore).toBe(0.1);
    expect(evaluation.decision).toBe("allow");
    expect(evaluation.reasons).toEqual([]);

    // Verify the dispatch was stamped
    const row = sqlite
      .prepare("SELECT input FROM dispatch_queue WHERE id = ?")
      .get(dispatchId) as { input: string };

    const input = JSON.parse(row.input);
    expect(input.riskScore).toBe(0.1);
    expect(input.autopilotDecision).toBe("allow");
    expect(input.reasons).toEqual([]);
  });

  it("processes dispatch without policy decision", () => {
    const service = new AutopilotService(sqlite);
    const dispatchId = "dispatch-123";
    
    seedDispatch(dispatchId, "sms_send", null);

    const evaluation = service.processDispatch(dispatchId);

    expect(evaluation.riskScore).toBe(0.55);
    expect(evaluation.decision).toBe("needsApproval");
    expect(evaluation.reasons).toContain("action_type.high_risk");
  });

  it("processes dispatch with content flags in input", () => {
    const service = new AutopilotService(sqlite);
    const dispatchId = "dispatch-123";
    
    seedDispatch(dispatchId, "memory_write", null, {
      hasFairHousingKeywords: true,
      hasTcpaViolations: false,
    });

    const evaluation = service.processDispatch(dispatchId);

    expect(evaluation.riskScore).toBe(0.3);
    expect(evaluation.decision).toBe("needsApproval");
    expect(evaluation.reasons).toContain("fair_housing.keyword_match");
  });

  it("throws error for non-existent dispatch", () => {
    const service = new AutopilotService(sqlite);
    
    expect(() => {
      service.processDispatch("non-existent");
    }).toThrow("Dispatch non-existent not found");
  });
});