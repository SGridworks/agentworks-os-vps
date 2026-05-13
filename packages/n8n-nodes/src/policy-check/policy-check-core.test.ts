/**
 * policy-check-core tests.
 *
 *   - validates required params
 *   - POSTs to /api/policy/check with the right body
 *   - sends Bearer auth when apiKey is set
 *   - parses each decision shape correctly
 *   - rejects unexpected decision values
 *   - HTTP errors throw with status info
 *   - decisionOutputIndex routes to the right n8n output
 */

import { describe, it, expect } from "vitest";
import {
  runPolicyCheck,
  decisionOutputIndex,
  type PolicyCheckParams,
  type PolicyCheckResult,
} from "./policy-check-core";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch;
}

const BASE_PARAMS: PolicyCheckParams = {
  actionKind: "outbound.sms",
  tenantId: "11111111-1111-1111-1111-111111111111",
  actorId: "agent-1",
  payload: { to: "+15551234567", body: "hi" },
};

describe("runPolicyCheck", () => {
  it("requires actionKind, tenantId, and actorId", async () => {
    const opts = {
      baseUrl: "http://x",
      fetchImpl: fakeFetch(async () => jsonResponse({ decision: "allow" })),
    };
    await expect(runPolicyCheck({ ...BASE_PARAMS, actionKind: "" }, opts)).rejects.toThrow(/actionKind/);
    await expect(runPolicyCheck({ ...BASE_PARAMS, tenantId: "" }, opts)).rejects.toThrow(/tenantId/);
    await expect(runPolicyCheck({ ...BASE_PARAMS, actorId: "" }, opts)).rejects.toThrow(/actorId/);
  });

  it("POSTs to <baseUrl>/api/policy/check with the canonical body", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const result = await runPolicyCheck(BASE_PARAMS, {
      baseUrl: "http://127.0.0.1:3100/",
      fetchImpl: fakeFetch(async (url, init) => {
        captured = { url, init };
        return jsonResponse({
          decision: "allow",
          ruleId: null,
          reason: "default_allow",
          requestId: "r1",
          decisionId: "d1",
          shadowMode: false,
          approvalQueueId: null,
          reviewed: false,
        } satisfies PolicyCheckResult);
      }),
    });

    expect(result.decision).toBe("allow");
    expect(captured).not.toBeNull();
    const cap = captured as unknown as { url: string; init: RequestInit };
    expect(cap.url).toBe("http://127.0.0.1:3100/api/policy/check");
    expect(cap.init.method).toBe("POST");
    const headers = cap.init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBeUndefined();

    const body = JSON.parse(String(cap.init.body));
    expect(body).toMatchObject({
      tenantId: BASE_PARAMS.tenantId,
      actionKind: "outbound.sms",
      actorId: "agent-1",
      payload: { to: "+15551234567", body: "hi" },
    });
  });

  it("sends Bearer auth when apiKey is set", async () => {
    let headers: Record<string, string> = {};
    await runPolicyCheck(BASE_PARAMS, {
      baseUrl: "http://x",
      apiKey: "secret-1",
      fetchImpl: fakeFetch(async (_url, init) => {
        headers = init.headers as Record<string, string>;
        return jsonResponse({
          decision: "allow",
          ruleId: null,
          reason: "ok",
          requestId: "r",
          decisionId: "d",
          shadowMode: false,
          approvalQueueId: null,
          reviewed: false,
        });
      }),
    });
    expect(headers.authorization).toBe("Bearer secret-1");
  });

  it("parses block decisions", async () => {
    const r = await runPolicyCheck(BASE_PARAMS, {
      baseUrl: "http://x",
      fetchImpl: fakeFetch(async () =>
        jsonResponse({
          decision: "block",
          ruleId: "tcpa-real-estate",
          reason: "TCPA-RE-001 dnc",
          requestId: "r1",
          decisionId: "d1",
          shadowMode: false,
          approvalQueueId: null,
          reviewed: false,
        }),
      ),
    });
    expect(r.decision).toBe("block");
    expect(r.ruleId).toBe("tcpa-real-estate");
    expect(r.reason).toMatch(/TCPA/);
  });

  it("parses route_to_review decisions and surfaces approvalQueueId", async () => {
    const r = await runPolicyCheck(BASE_PARAMS, {
      baseUrl: "http://x",
      fetchImpl: fakeFetch(async () =>
        jsonResponse({
          decision: "route_to_review",
          ruleId: "fair-housing",
          reason: "missing protected_class evidence",
          requestId: "r1",
          decisionId: "d1",
          shadowMode: false,
          approvalQueueId: "aq-1",
          reviewed: false,
        }),
      ),
    });
    expect(r.decision).toBe("route_to_review");
    expect(r.approvalQueueId).toBe("aq-1");
  });

  it("rejects unexpected decision values", async () => {
    await expect(
      runPolicyCheck(BASE_PARAMS, {
        baseUrl: "http://x",
        fetchImpl: fakeFetch(async () => jsonResponse({ decision: "maybe" })),
      }),
    ).rejects.toThrow(/unexpected decision/);
  });

  it("non-2xx HTTP throws with status info", async () => {
    await expect(
      runPolicyCheck(BASE_PARAMS, {
        baseUrl: "http://x",
        fetchImpl: fakeFetch(async () => new Response("nope", { status: 503 })),
      }),
    ).rejects.toThrow(/HTTP 503/);
  });

  it("forwards shadowMode override only when set", async () => {
    let body: Record<string, unknown> = {};
    await runPolicyCheck({ ...BASE_PARAMS, shadowMode: true }, {
      baseUrl: "http://x",
      fetchImpl: fakeFetch(async (_url, init) => {
        body = JSON.parse(String(init.body));
        return jsonResponse({
          decision: "allow",
          ruleId: null,
          reason: "ok",
          requestId: "r",
          decisionId: "d",
          shadowMode: true,
          approvalQueueId: null,
          reviewed: false,
        });
      }),
    });
    expect(body.shadowMode).toBe(true);

    body = {};
    await runPolicyCheck(BASE_PARAMS, {
      baseUrl: "http://x",
      fetchImpl: fakeFetch(async (_url, init) => {
        body = JSON.parse(String(init.body));
        return jsonResponse({
          decision: "allow",
          ruleId: null,
          reason: "ok",
          requestId: "r",
          decisionId: "d",
          shadowMode: false,
          approvalQueueId: null,
          reviewed: false,
        });
      }),
    });
    expect("shadowMode" in body).toBe(false);
  });
});

describe("decisionOutputIndex", () => {
  it("routes allow→0, block→1, route_to_review→2", () => {
    expect(decisionOutputIndex("allow")).toBe(0);
    expect(decisionOutputIndex("block")).toBe(1);
    expect(decisionOutputIndex("route_to_review")).toBe(2);
  });
});
