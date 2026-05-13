/**
 * dispatch-core tests.
 *
 *   - validates required params
 *   - POSTs to /api/dispatch with the canonical body
 *   - sends Bearer auth when apiKey is set
 *   - parses {taskId, status} reply
 *   - rejects unknown status values
 *   - HTTP error throws with status info
 *   - includes policyDecisionId only when set
 */

import { describe, it, expect } from "vitest";
import { runDispatch, type DispatchParams } from "./dispatch-core";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch;
}

const BASE_PARAMS: DispatchParams = {
  tenantId: "11111111-1111-1111-1111-111111111111",
  taskKind: "outbound.sms",
  targetAgentId: "agent-1",
  input: { to: "+15551234567", body: "hi" },
};

describe("runDispatch", () => {
  it("requires tenantId, taskKind, and targetAgentId", async () => {
    const opts = {
      baseUrl: "http://x",
      fetchImpl: fakeFetch(async () =>
        jsonResponse({ taskId: "t-1", status: "queued" }, 201),
      ),
    };
    await expect(runDispatch({ ...BASE_PARAMS, tenantId: "" }, opts)).rejects.toThrow(
      /tenantId/,
    );
    await expect(runDispatch({ ...BASE_PARAMS, taskKind: "" }, opts)).rejects.toThrow(
      /taskKind/,
    );
    await expect(
      runDispatch({ ...BASE_PARAMS, targetAgentId: "" }, opts),
    ).rejects.toThrow(/targetAgentId/);
  });

  it("POSTs to <baseUrl>/api/dispatch with the canonical body", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const result = await runDispatch(BASE_PARAMS, {
      baseUrl: "http://127.0.0.1:3100/",
      fetchImpl: fakeFetch(async (url, init) => {
        captured = { url, init };
        return jsonResponse(
          {
            taskId: "task-123",
            status: "queued",
            taskKind: "outbound.sms",
            targetAgentId: "agent-1",
            tenantId: BASE_PARAMS.tenantId,
            createdAt: "2026-04-28T00:00:00.000Z",
          },
          201,
        );
      }),
    });

    expect(result.taskId).toBe("task-123");
    expect(result.status).toBe("queued");

    expect(captured).not.toBeNull();
    const cap = captured as unknown as { url: string; init: RequestInit };
    expect(cap.url).toBe("http://127.0.0.1:3100/api/dispatch");
    expect(cap.init.method).toBe("POST");
    const body = JSON.parse(String(cap.init.body));
    expect(body).toMatchObject({
      tenantId: BASE_PARAMS.tenantId,
      taskKind: "outbound.sms",
      targetAgentId: "agent-1",
      input: { to: "+15551234567", body: "hi" },
    });
    expect("policyDecisionId" in body).toBe(false);
  });

  it("includes policyDecisionId when set", async () => {
    let body: Record<string, unknown> = {};
    await runDispatch(
      { ...BASE_PARAMS, policyDecisionId: "decision-1" },
      {
        baseUrl: "http://x",
        fetchImpl: fakeFetch(async (_url, init) => {
          body = JSON.parse(String(init.body));
          return jsonResponse(
            { taskId: "t-1", status: "queued", taskKind: "x.y", targetAgentId: "a", tenantId: "t", createdAt: "x" },
            201,
          );
        }),
      },
    );
    expect(body.policyDecisionId).toBe("decision-1");
  });

  it("sends Bearer auth when apiKey is set", async () => {
    let headers: Record<string, string> = {};
    await runDispatch(BASE_PARAMS, {
      baseUrl: "http://x",
      apiKey: "tok",
      fetchImpl: fakeFetch(async (_url, init) => {
        headers = init.headers as Record<string, string>;
        return jsonResponse(
          { taskId: "t-1", status: "queued", taskKind: "x.y", targetAgentId: "a", tenantId: "t", createdAt: "x" },
          201,
        );
      }),
    });
    expect(headers.authorization).toBe("Bearer tok");
  });

  it("rejects unknown status values from the daemon", async () => {
    await expect(
      runDispatch(BASE_PARAMS, {
        baseUrl: "http://x",
        fetchImpl: fakeFetch(async () =>
          jsonResponse({ taskId: "t-1", status: "weird" }, 201),
        ),
      }),
    ).rejects.toThrow(/unknown status/);
  });

  it("rejects reply with missing taskId or status", async () => {
    await expect(
      runDispatch(BASE_PARAMS, {
        baseUrl: "http://x",
        fetchImpl: fakeFetch(async () =>
          jsonResponse({ status: "queued" }, 201),
        ),
      }),
    ).rejects.toThrow(/unexpected reply shape/);
  });

  it("non-2xx HTTP throws with status info", async () => {
    await expect(
      runDispatch(BASE_PARAMS, {
        baseUrl: "http://x",
        fetchImpl: fakeFetch(async () => new Response("nope", { status: 503 })),
      }),
    ).rejects.toThrow(/HTTP 503/);
  });
});
