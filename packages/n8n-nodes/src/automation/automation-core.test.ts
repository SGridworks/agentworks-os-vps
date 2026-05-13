import { describe, expect, it } from "vitest";
import {
  runAutomationAction,
  type AutomationParams,
} from "./automation-core";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(impl: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch;
}

const BASE: AutomationParams = {
  operation: "issue.create",
  tenantId: "tenant-1",
  companyId: "company-1",
  payload: { title: "Do work" },
};

describe("runAutomationAction", () => {
  it("requires tenant id", async () => {
    await expect(
      runAutomationAction({ ...BASE, tenantId: "" }, { baseUrl: "http://x" }),
    ).rejects.toThrow(/tenantId/);
  });

  it("posts issue creation to the company issue endpoint", async () => {
    let captured: { url: string; body: Record<string, unknown> } | null = null;
    const result = await runAutomationAction(BASE, {
      baseUrl: "http://agentos",
      fetchImpl: fakeFetch(async (url, init) => {
        captured = { url, body: JSON.parse(String(init.body)) };
        return jsonResponse({ id: "issue-1" }, 201);
      }),
    });

    expect(result.status).toBe(201);
    expect(captured?.url).toBe("http://agentos/api/companies/company-1/issues");
    expect(captured?.body).toMatchObject({ tenantId: "tenant-1", title: "Do work" });
  });

  it("patches issue updates by issue id", async () => {
    let method = "";
    let urlSeen = "";
    await runAutomationAction(
      {
        operation: "issue.update",
        tenantId: "tenant-1",
        issueId: "issue-1",
        payload: { status: "blocked" },
      },
      {
        baseUrl: "http://agentos/",
        fetchImpl: fakeFetch(async (url, init) => {
          urlSeen = url;
          method = String(init.method);
          return jsonResponse({ ok: true });
        }),
      },
    );

    expect(method).toBe("PATCH");
    expect(urlSeen).toBe("http://agentos/api/issues/issue-1");
  });

  it("sends bearer auth when apiKey is set", async () => {
    let headers: Record<string, string> = {};
    await runAutomationAction(BASE, {
      baseUrl: "http://agentos",
      apiKey: "tok",
      fetchImpl: fakeFetch(async (_url, init) => {
        headers = init.headers as Record<string, string>;
        return jsonResponse({ ok: true });
      }),
    });

    expect(headers.authorization).toBe("Bearer tok");
  });

  it("throws on HTTP errors", async () => {
    await expect(
      runAutomationAction(BASE, {
        baseUrl: "http://agentos",
        fetchImpl: fakeFetch(async () => new Response("bad", { status: 500 })),
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

