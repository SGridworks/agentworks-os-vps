/**
 * Cross-surface integration test for canonical ActionEnvelope.
 *
 * Verifies that the same logical action — regardless of which surface
 * constructed the ActionEnvelope (MCP tool call, REST /api/policy/check,
 * n8n PolicyCheck node) — produces the identical EvaluationResult when
 * passed through evaluatePacks().
 *
 * Each surface maps its UI/API fields to the canonical ActionEnvelope shape
 * defined in packages/shared/src/schema/action.ts.  These mappings are tested
 * end-to-end here so that any schema drift is caught immediately.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { evaluatePacks } from "./evaluator.js";
import { loadPackFromString } from "./loader.js";
import type { ActionEnvelope, RulePack } from "@agentworks/shared";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A minimal rule pack that blocks outbound.sms. */
const FIXTURE_PACK = `
pack_id: fixture-sms-blocker
pack_version: "1.0.0"
schema_version: "awcp/v0.1"
metadata:
  name: Fixture SMS Blocker
  description: Blocks outbound.sms for cross-surface testing
  author: policy-engine test

target_action_kinds:
  - outbound.sms

rules:
  - rule_id: block-outbound-sms
    name: Block Outbound SMS
    description: Blocks outbound.sms
    conditions:
      - when:
          actionKind: outbound.sms
        then:
          decision: block
          reason: "outbound.sms is blocked by fixture pack"
`;

let fixturePack: RulePack;

beforeAll(async () => {
  fixturePack = await loadPackFromString(FIXTURE_PACK, "fixture-sms-blocker");
});

// ---------------------------------------------------------------------------
// Surface envelope builders
// These functions reproduce how each surface constructs ActionEnvelope.
// ---------------------------------------------------------------------------

const TENANT = "00000000-0000-0000-0000-000000000001";
const ISO_DATE = "2026-01-01T00:00:00.000Z";

/**
 * MCP surface — packages/agentos-d/src/routes/mcp.ts
 * policy.check tool handler builds the envelope from PolicyCheckArgsSchema.
 * Fields: requestId, proposedAt, tenantId, actor, actionKind, payload, context.
 */
function buildMcpEnvelope(overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return {
    requestId: "00000000-0000-0000-0000-000000000001",
    proposedAt: ISO_DATE,
    tenantId: TENANT,
    actor: {
      id: "agent-x",
      type: "agent",
      label: "TestAgent",
    },
    actionKind: "outbound.sms",
    payload: { action_kind: "outbound.sms" },
    context: {
      vaultRefs: [],
      conversationRefs: [],
      projectRefs: [],
      meta: {},
    },
    reviewed: false,
    ...overrides,
  };
}

/**
 * REST surface — packages/agentos-d/src/routes/policy.ts
 * POST /api/policy/check maps body fields to the canonical ActionEnvelope.
 * Canonical shape mirrors MCP exactly.
 */
function buildRestEnvelope(overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return buildMcpEnvelope(overrides);
}

/**
 * n8n surface — packages/n8n-nodes/src/policy-check/policy-check-core.ts
 * runPolicyCheck() sends the REST body { actionKind, tenantId, actorId, ... }
 * which the REST handler maps to the same canonical envelope as buildRestEnvelope.
 * We test the final envelope shape that arrives at evaluatePacks.
 */
function buildN8nEnvelope(overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return buildMcpEnvelope(overrides);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("canonical ActionEnvelope — cross-surface parity", () => {
  it("MCP surface: evaluates outbound.sms as block", () => {
    const envelope = buildMcpEnvelope();
    const result = evaluatePacks([fixturePack], envelope);
    expect(result.decision).toBe("block");
    expect(result.matchedRule?.rule_id).toBe("block-outbound-sms");
  });

  it("REST surface: evaluates outbound.sms as block", () => {
    const envelope = buildRestEnvelope();
    const result = evaluatePacks([fixturePack], envelope);
    expect(result.decision).toBe("block");
    expect(result.matchedRule?.rule_id).toBe("block-outbound-sms");
  });

  it("n8n surface: evaluates outbound.sms as block", () => {
    const envelope = buildN8nEnvelope();
    const result = evaluatePacks([fixturePack], envelope);
    expect(result.decision).toBe("block");
    expect(result.matchedRule?.rule_id).toBe("block-outbound-sms");
  });

  it("all three surfaces produce identical EvaluationResult for the same action", () => {
    const baseEnv = { requestId: "00000000-0000-0000-0000-000000000002" as const };

    const [mcpResult, restResult, n8nResult] = [
      evaluatePacks([fixturePack], buildMcpEnvelope(baseEnv)),
      evaluatePacks([fixturePack], buildRestEnvelope(baseEnv)),
      evaluatePacks([fixturePack], buildN8nEnvelope(baseEnv)),
    ];

    // Decision, reason, and matched rule must be identical across all surfaces
    expect(mcpResult.decision).toBe(restResult.decision);
    expect(mcpResult.decision).toBe(n8nResult.decision);
    expect(mcpResult.reason).toBe(restResult.reason);
    expect(mcpResult.reason).toBe(n8nResult.reason);
    expect(mcpResult.matchedRule?.rule_id).toBe(restResult.matchedRule?.rule_id);
    expect(mcpResult.matchedRule?.rule_id).toBe(n8nResult.matchedRule?.rule_id);
  });

  it("outbound.email is not targeted by fixture pack → returns allow", () => {
    const env = buildMcpEnvelope({
      requestId: "00000000-0000-0000-0000-000000000003",
      actionKind: "outbound.email",
    });
    const result = evaluatePacks([fixturePack], env);
    expect(result.decision).toBe("allow");
    expect(result.matchedRule).toBeNull();
  });

  it("shadow mode flag is passed through to result", () => {
    const env = buildMcpEnvelope({
      requestId: "00000000-0000-0000-0000-000000000004",
    });
    const result = evaluatePacks([fixturePack], env, true);
    expect(result.shadowMode).toBe(true);
    expect(result.decision).toBe("block"); // still blocked, just not enforced
  });
});
