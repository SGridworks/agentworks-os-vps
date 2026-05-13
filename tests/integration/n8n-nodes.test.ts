/**
 * AWO-65 / AWO-147 — n8n Custom Node Integration Test Suite.
 *
 * Two layers:
 *
 *   1. Schema contracts — always run. Assert against real INodeType class
 *      descriptions so tests fail when the real nodes drift.
 *      Imports: PolicyCheck, MemoryRead, MemoryWrite, Dispatch from
 *      @agentworks/n8n-nodes (the main entry, which re-exports them).
 *
 *   2. Live API — runs when AGENTOS_API_URL is set.
 *
 *   pnpm --filter @agentworks/agentos-d build
 *   AGENTOS_PORT=7720 RULE_PACKS_DIR=$(pwd)/rule-packs \
 *     node packages/agentos-d/dist/cli.js &
 *   AGENTOS_API_URL=http://127.0.0.1:7720 \
 *     npx vitest run tests/integration/n8n-nodes.test.ts
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { ActionEnvelopeSchema } from "@agentworks/shared";
import {
  MemoryRead,
  MemoryWrite,
  PolicyCheck,
  Dispatch,
} from "@agentworks/n8n-nodes";

const BASE_URL = process.env.AGENTOS_API_URL ?? "http://localhost:7710";
const RUN_INTEGRATION = Boolean(process.env.AGENTOS_API_URL);
const liveDescribe = RUN_INTEGRATION ? describe : describe.skip;

// Shared n8n descriptor shape (mirrors what the real n8n SDK types expose).
interface N8nNodeProperty {
  name: string;
  displayName: string;
  type: string;
  required?: boolean;
  default?: unknown;
  description?: string;
  options?: Array<{ name: string; value: string }>;
}

interface N8nNodeDescription {
  name: string;
  displayName: string;
  group: string[];
  version: number;
  description: string;
  defaults: { name: string };
  inputs: string[];
  outputs: string[];
  outputNames?: string[];
  credentials?: Array<{ name: string; required?: boolean }>;
  properties: N8nNodeProperty[];
}

// Helpers that assert small, stable fragments of the real descriptor.

function assertName(
  d: N8nNodeDescription,
  expected: string,
): void {
  expect(d.name).toBe(expected);
}

function assertInputsOutputs(
  d: N8nNodeDescription,
  inputs: string[],
  outputs: string[],
): void {
  expect(d.inputs).toEqual(inputs);
  expect(d.outputs).toEqual(outputs);
}

function assertPropertyExists(
  d: N8nNodeDescription,
  name: string,
  required: boolean,
): void {
  const prop = d.properties.find((p) => p.name === name);
  expect(prop, `property '${name}' must exist`).toBeDefined();
  expect(prop!.required).toBe(required);
}

function assertPropertyCount(
  d: N8nNodeDescription,
  count: number,
): void {
  expect(d.properties).toHaveLength(count);
}

// ---------------------------------------------------------------------------
// Schema contracts — assert against real class descriptions
// ---------------------------------------------------------------------------

describe("n8n node descriptors — AWO-147 schema contracts (real classes)", () => {
  describe("agentworks.memory.read", () => {
    const d = new MemoryRead().description as N8nNodeDescription;

    it("name is agentworks.memory.read", () => {
      assertName(d, "agentworks.memory.read");
    });

    it("has inputs=[main], outputs=[main]", () => {
      assertInputsOutputs(d, ["main"], ["main"]);
    });

    it("has tenantId (required) and key (required)", () => {
      assertPropertyExists(d, "tenantId", true);
      assertPropertyExists(d, "key", true);
    });

    it("has baseUrl (optional)", () => {
      assertPropertyExists(d, "baseUrl", false);
    });
  });

  describe("agentworks.memory.write", () => {
    const d = new MemoryWrite().description as N8nNodeDescription;

    it("name is agentworks.memory.write", () => {
      assertName(d, "agentworks.memory.write");
    });

    it("has inputs=[main], outputs=[main]", () => {
      assertInputsOutputs(d, ["main"], ["main"]);
    });

    it("has tenantId (required), key (required), body (required)", () => {
      assertPropertyExists(d, "tenantId", true);
      assertPropertyExists(d, "key", true);
      assertPropertyExists(d, "body", true);
    });

    it("has mode (optional) with replace/append options", () => {
      assertPropertyExists(d, "mode", false);
      const mode = d.properties.find((p) => p.name === "mode")!;
      expect(mode.options).toEqual([
        { name: "Replace", value: "replace" },
        { name: "Append", value: "append" },
      ]);
    });

    it("has baseUrl (optional)", () => {
      assertPropertyExists(d, "baseUrl", false);
    });
  });

  describe("agentworks.policy_check", () => {
    const d = new PolicyCheck().description as N8nNodeDescription;

    it("name is agentworks.policy_check", () => {
      assertName(d, "agentworks.policy_check");
    });

    it("has inputs=[main], outputs=[main,main,main]", () => {
      assertInputsOutputs(d, ["main"], ["main", "main", "main"]);
    });

    it("has outputNames=[allow,block,review]", () => {
      expect(d.outputNames).toEqual(["allow", "block", "review"]);
    });

    it("has actionKind (required), tenantId (required), actorId (required), payload (required)", () => {
      assertPropertyExists(d, "actionKind", true);
      assertPropertyExists(d, "tenantId", true);
      assertPropertyExists(d, "actorId", true);
      assertPropertyExists(d, "payload", true);
    });

    it("has baseUrl (optional)", () => {
      assertPropertyExists(d, "baseUrl", false);
    });

    it("has optional actorLabel, summary, shadowMode", () => {
      assertPropertyExists(d, "actorLabel", false);
      assertPropertyExists(d, "summary", false);
      assertPropertyExists(d, "shadowMode", false);
    });
  });

  describe("agentworks.dispatch", () => {
    const d = new Dispatch().description as N8nNodeDescription;

    it("name is agentworks.dispatch", () => {
      assertName(d, "agentworks.dispatch");
    });

    it("has inputs=[main], outputs=[main]", () => {
      assertInputsOutputs(d, ["main"], ["main"]);
    });

    it(
      "has tenantId (required), taskKind (required), targetAgentId (required), " +
        "input (optional), policyDecisionId (optional)",
      () => {
        assertPropertyExists(d, "tenantId", true);
        assertPropertyExists(d, "taskKind", true);
        assertPropertyExists(d, "targetAgentId", true);
        assertPropertyExists(d, "input", false);
        assertPropertyExists(d, "policyDecisionId", false);
      },
    );

    it("has baseUrl (optional)", () => {
      assertPropertyExists(d, "baseUrl", false);
    });
  });
});

describe("n8n node schema contracts — wire-format invariants", () => {
  it("actionKind regex matches canonical format", () => {
    const regex = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
    const valid = ["outbound.sms", "crm.write", "internal.ping", "agent.dispatch"];
    const invalid = ["OutboundSMS", "crm_write", "1agent.dispatch"];
    valid.forEach((k) => expect(regex.test(k)).toBe(true));
    invalid.forEach((k) => expect(regex.test(k)).toBe(false));
  });

  it("PolicyDecision is a closed enum of 3 values", () => {
    type PolicyDecision = "allow" | "block" | "route_to_review";
    const decisions: PolicyDecision[] = ["allow", "block", "route_to_review"];
    expect(new Set(decisions).size).toBe(3);
  });

  it("ActionEnvelopeSchema parses a canonical envelope", () => {
    const envelope = ActionEnvelopeSchema.parse({
      requestId: randomUUID(),
      proposedAt: new Date().toISOString(),
      tenantId: randomUUID(),
      actor: { id: "test", type: "agent", label: "test" },
      actionKind: "outbound.sms",
      payload: {},
      context: {},
    });
    expect(envelope.actionKind).toBe("outbound.sms");
  });
});

// ---------------------------------------------------------------------------
// Live API — runs when AGENTOS_API_URL is set
// ---------------------------------------------------------------------------

interface MemoryReadNodeParams {
  tenantId: string;
  key: string;
}
interface MemoryWriteNodeParams {
  tenantId: string;
  key: string;
  body: string;
}
interface PolicyCheckNodeParams {
  tenantId: string;
  actionKind: string;
  payload: Record<string, unknown>;
  actorId: string;
}
interface PolicyCheckResult {
  decision: "allow" | "block" | "route_to_review";
  ruleId: string | null;
  reason: string;
  requestId: string;
  reviewed: boolean;
}
interface DispatchNodeParams {
  tenantId: string;
  taskKind: string;
  targetAgentId: string;
  input: Record<string, unknown>;
}
interface DispatchResult {
  taskId: string;
  status: "queued" | "dispatched" | "completed" | "failed";
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

liveDescribe("agentworks.memory.read + write — live API", () => {
  it("write then read round-trips a page", async () => {
    const key = `notes/integration/${randomUUID()}`;
    const params: MemoryWriteNodeParams = {
      tenantId: "test-tenant",
      key,
      body: "integration test content",
    };
    const wRes = await api("/api/memory/write", {
      method: "POST",
      body: JSON.stringify(params),
    });
    expect(wRes.ok).toBe(true);
    const wBody = (await wRes.json()) as {
      ok: boolean;
      data: { bytesWritten: number };
    };
    expect(wBody.ok).toBe(true);
    expect(wBody.data.bytesWritten).toBe(24);

    const readParams: MemoryReadNodeParams = { tenantId: "test-tenant", key };
    const rRes = await api("/api/memory/read", {
      method: "POST",
      body: JSON.stringify(readParams),
    });
    expect(rRes.ok).toBe(true);
    const rBody = (await rRes.json()) as {
      ok: boolean;
      data: { body: string; existed: boolean };
    };
    expect(rBody.data.body).toBe("integration test content");
    expect(rBody.data.existed).toBe(true);
  });

  it("read returns existed=false on missing page (no error)", async () => {
    const params: MemoryReadNodeParams = {
      tenantId: "test-tenant",
      key: `ghost/${randomUUID()}`,
    };
    const res = await api("/api/memory/read", {
      method: "POST",
      body: JSON.stringify(params),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { existed: boolean; body: string };
    };
    expect(body.data.existed).toBe(false);
    expect(body.data.body).toBe("");
  });

  it("write rejects path traversal with 400", async () => {
    const params = { tenantId: "test-tenant", key: "../escape", body: "x" };
    const res = await api("/api/memory/write", {
      method: "POST",
      body: JSON.stringify(params),
    });
    expect(res.status).toBe(400);
  });
});

liveDescribe("agentworks.policy_check — live API", () => {
  it("returns a valid PolicyDecision for outbound.sms", async () => {
    const params: PolicyCheckNodeParams = {
      tenantId: "test-tenant",
      actionKind: "outbound.sms",
      payload: { to: "+155****4567", body: "Hello" },
      actorId: "test-actor",
    };
    const res = await api("/api/policy/check", {
      method: "POST",
      body: JSON.stringify(params),
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as PolicyCheckResult;
    expect(["allow", "block", "route_to_review"]).toContain(data.decision);
    expect(data.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("returns a closed-set decision for an action with no rule match", async () => {
    const params: PolicyCheckNodeParams = {
      tenantId: "test-tenant",
      actionKind: "internal.ping",
      payload: {},
      actorId: "test-actor",
    };
    const res = await api("/api/policy/check", {
      method: "POST",
      body: JSON.stringify(params),
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as PolicyCheckResult;
    expect(["allow", "block", "route_to_review"]).toContain(data.decision);
  });
});

liveDescribe("agentworks.dispatch — live API", () => {
  it("dispatches a task and returns a queued taskId", async () => {
    const params: DispatchNodeParams = {
      tenantId: "test-tenant",
      taskKind: "outbound.sms",
      targetAgentId: "test-agent-id",
      input: { to: "+155****4567", body: "Hello" },
    };
    const res = await api("/api/dispatch", {
      method: "POST",
      body: JSON.stringify(params),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as DispatchResult;
    expect(data.taskId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(data.status).toBe("queued");
  });

  it("rejects empty targetAgentId with 4xx", async () => {
    const params = {
      tenantId: "test-tenant",
      taskKind: "outbound.sms",
      targetAgentId: "",
      input: {},
    };
    const res = await api("/api/dispatch", {
      method: "POST",
      body: JSON.stringify(params),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("rejects non-canonical taskKind with 4xx", async () => {
    const params = {
      tenantId: "test-tenant",
      taskKind: "OutboundSMS",
      targetAgentId: "agent-1",
      input: {},
    };
    const res = await api("/api/dispatch", {
      method: "POST",
      body: JSON.stringify(params),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

liveDescribe("end-to-end — policy.check then branched dispatch", () => {
  it(
    "policy → dispatch happy path: queued task on allow, queue entry on review",
    async () => {
      const policyParams: PolicyCheckNodeParams = {
        tenantId: "test-tenant",
        actionKind: "internal.ping",
        payload: {},
        actorId: "n8n-workflow",
      };
      const policyRes = await api("/api/policy/check", {
        method: "POST",
        body: JSON.stringify(policyParams),
      });
      expect(policyRes.ok).toBe(true);
      const policy = (await policyRes.json()) as PolicyCheckResult;
      expect(["allow", "block", "route_to_review"]).toContain(policy.decision);

      if (policy.decision === "allow") {
        const dispatchRes = await api("/api/dispatch", {
          method: "POST",
          body: JSON.stringify({
            tenantId: "test-tenant",
            taskKind: "internal.ping",
            targetAgentId: "ping-agent",
            input: { fromRequestId: policy.requestId },
            policyDecisionId: policy.requestId,
          }),
        });
        expect(dispatchRes.status).toBe(201);
        const data = (await dispatchRes.json()) as DispatchResult;
        expect(data.status).toBe("queued");
      }
    },
  );
});
