import { describe, it, expect } from "vitest";
import { ActionEnvelopeSchema, ActorSchema, ActionContextSchema } from "./action.js";

describe("ActorSchema", () => {
  it("parses a valid human actor", () => {
    const actor = {
      id: "user-1",
      type: "human",
      label: "Jane Doe",
      role: "admin",
    };
    expect(ActorSchema.parse(actor)).toEqual(actor);
  });

  it("parses a valid agent actor", () => {
    const actor = {
      id: "agent-claude-1",
      type: "agent",
      label: "Claude",
      adapterKey: "claude-local",
    };
    expect(ActorSchema.parse(actor)).toEqual(actor);
  });

  it("parses a valid system actor", () => {
    const actor = {
      id: "scanner-1",
      type: "system",
      label: "AgentGuard Scanner",
    };
    expect(ActorSchema.parse(actor)).toEqual(actor);
  });

  it("rejects invalid actor type", () => {
    expect(() =>
      ActorSchema.parse({ id: "x", type: "robot", label: "X" })
    ).toThrow();
  });

  it("requires id and label", () => {
    expect(() => ActorSchema.parse({ type: "human" })).toThrow();
    expect(() => ActorSchema.parse({ id: "x" })).toThrow();
  });
});

describe("ActionContextSchema", () => {
  it("parses empty context with defaults", () => {
    const ctx = ActionContextSchema.parse({});
    expect(ctx.vaultRefs).toEqual([]);
    expect(ctx.conversationRefs).toEqual([]);
    expect(ctx.projectRefs).toEqual([]);
    expect(ctx.meta).toEqual({});
  });

  it("parses context with all fields", () => {
    const ctx = {
      vaultRefs: ["vault-doc-1", "vault-doc-2"],
      conversationRefs: ["conv-1"],
      projectRefs: ["proj-1"],
      raw: { provider: "openai", response: {} },
      meta: { source: "mcp" },
    };
    expect(ActionContextSchema.parse(ctx)).toEqual(ctx);
  });
});

describe("ActionEnvelopeSchema", () => {
  const validEnvelope = {
    requestId: "550e8400-e29b-41d4-a716-446655440000",
    proposedAt: "2026-04-27T12:00:00.000Z",
    tenantId: "660e8400-e29b-41d4-a716-446655440000",
    actor: {
      id: "agent-1",
      type: "agent",
      label: "Claude",
    },
    actionKind: "outbound.sms",
    payload: {
      recipient: "+15551234567",
      channel: "sms",
      content: "Hello, this is a test.",
    },
    context: {
      vaultRefs: [],
      conversationRefs: [],
      projectRefs: [],
      meta: {},
    },
    reviewed: false,
  };

  it("parses a valid action envelope", () => {
    expect(ActionEnvelopeSchema.parse(validEnvelope)).toEqual(validEnvelope);
  });

  it("accepts valid dot-namespaced actionKind", () => {
    const env = { ...validEnvelope, actionKind: "crm.write" };
    expect(ActionEnvelopeSchema.parse(env).actionKind).toBe("crm.write");

    const env2 = { ...validEnvelope, actionKind: "llm.completion" };
    expect(ActionEnvelopeSchema.parse(env2).actionKind).toBe("llm.completion");

    const env3 = { ...validEnvelope, actionKind: "memory.read" };
    expect(ActionEnvelopeSchema.parse(env3).actionKind).toBe("memory.read");
  });

  it("rejects actionKind without dot separator", () => {
    const env = { ...validEnvelope, actionKind: "sms" };
    expect(() => ActionEnvelopeSchema.parse(env)).toThrow();
  });

  it("rejects actionKind with uppercase", () => {
    const env = { ...validEnvelope, actionKind: "Outbound.SMS" };
    expect(() => ActionEnvelopeSchema.parse(env)).toThrow();
  });

  it("rejects actionKind starting with digit", () => {
    const env = { ...validEnvelope, actionKind: "1outbound.sms" };
    expect(() => ActionEnvelopeSchema.parse(env)).toThrow();
  });

  it("rejects invalid UUID for requestId", () => {
    const env = { ...validEnvelope, requestId: "not-a-uuid" };
    expect(() => ActionEnvelopeSchema.parse(env)).toThrow();
  });

  it("rejects invalid ISO datetime for proposedAt", () => {
    const env = { ...validEnvelope, proposedAt: "2026-04-27" };
    expect(() => ActionEnvelopeSchema.parse(env)).toThrow();
  });

  it("defaults reviewed to false", () => {
    const { reviewed, ...rest } = validEnvelope;
    const parsed = ActionEnvelopeSchema.parse(rest);
    expect(parsed.reviewed).toBe(false);
  });

  it("parses reviewerId and reviewedAt when set", () => {
    const env = {
      ...validEnvelope,
      reviewed: true,
      reviewerId: "user-1",
      reviewedAt: "2026-04-27T14:00:00.000Z",
    };
    const parsed = ActionEnvelopeSchema.parse(env);
    expect(parsed.reviewerId).toBe("user-1");
    expect(parsed.reviewedAt).toBe("2026-04-27T14:00:00.000Z");
  });

  it("accepts arbitrary payload shape (content-agnostic)", () => {
    const env1 = {
      ...validEnvelope,
      actionKind: "llm.completion",
      payload: { model: "claude-3-5-sonnet", prompt: "hi", completion: "hi" },
    };
    expect(ActionEnvelopeSchema.parse(env1)).toEqual(env1);

    const env2 = {
      ...validEnvelope,
      actionKind: "workflow.trigger",
      payload: { workflowId: "wf-1", stepId: "step-2", nodeType: "agentos.memory.read" },
    };
    expect(ActionEnvelopeSchema.parse(env2)).toEqual(env2);
  });

  it("accepts payload as empty object", () => {
    const env = { ...validEnvelope, payload: {} };
    expect(ActionEnvelopeSchema.parse(env).payload).toEqual({});
  });
});
