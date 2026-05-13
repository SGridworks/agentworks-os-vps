/**
 * Tests for memory-core.ts
 */

import { describe, it, expect, vi } from "vitest";
import { runMemoryRead, type MemoryReadParams } from "./memory-core.js";

const FAKE_TENANT = "tenant-1";
const FAKE_KEY = "test/key";

function mockFetch(data: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    text: async () => JSON.stringify(ok ? { ok: true, data } : { error: "server error" }),
  });
}

describe("runMemoryRead", () => {
  it("sends tier='index' in the request body when tier is index", async () => {
    let capturedBody: unknown;
    const fetchMock = mockFetch({
      tenantId: FAKE_TENANT,
      key: FAKE_KEY,
      body: undefined,
      sha256: "abc",
      updatedAt: "2026-01-01T00:00:00Z",
      existed: true,
      summary: "summary text",
      trigger: "trigger text",
    });

    // Spy to capture what is sent
    const fetchSpy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return fetchMock(url, init);
    });

    const params: MemoryReadParams = {
      tenantId: FAKE_TENANT,
      key: FAKE_KEY,
      tier: "index",
    };

    await runMemoryRead(params, { baseUrl: "http://127.0.0.1:3100", fetchImpl: fetchSpy });

    expect(capturedBody).toMatchObject({
      tenantId: FAKE_TENANT,
      key: FAKE_KEY,
      tier: "index",
    });
  });

  it("sends tier='detail' as default when tier is omitted", async () => {
    let capturedBody: unknown;
    const fetchSpy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      capturedBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return mockFetch({
        tenantId: FAKE_TENANT,
        key: FAKE_KEY,
        body: "full content",
        sha256: "abc",
        updatedAt: "2026-01-01T00:00:00Z",
        existed: true,
      })(url, init);
    });

    const params: MemoryReadParams = {
      tenantId: FAKE_TENANT,
      key: FAKE_KEY,
    };

    await runMemoryRead(params, { baseUrl: "http://127.0.0.1:3100", fetchImpl: fetchSpy });

    expect(capturedBody).toMatchObject({
      tenantId: FAKE_TENANT,
      key: FAKE_KEY,
      tier: "detail",
    });
  });

  it("returns summary and trigger from index-tier response", async () => {
    const fetchSpy = vi.fn().mockImplementation(async () =>
      mockFetch({
        tenantId: FAKE_TENANT,
        key: FAKE_KEY,
        sha256: "abc123",
        updatedAt: "2026-01-01T00:00:00Z",
        existed: true,
        summary: "Meeting with team",
        trigger: "standup",
      })(),
    );

    const result = await runMemoryRead(
      { tenantId: FAKE_TENANT, key: FAKE_KEY, tier: "index" },
      { baseUrl: "http://127.0.0.1:3100", fetchImpl: fetchSpy },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.summary).toBe("Meeting with team");
      expect(result.data.trigger).toBe("standup");
      expect(result.data.body).toBeUndefined();
    }
  });

  it("returns body in detail-tier response", async () => {
    const fetchSpy = vi.fn().mockImplementation(async () =>
      mockFetch({
        tenantId: FAKE_TENANT,
        key: FAKE_KEY,
        body: "Full content of the vault page",
        sha256: "def456",
        updatedAt: "2026-01-02T00:00:00Z",
        existed: true,
      })(),
    );

    const result = await runMemoryRead(
      { tenantId: FAKE_TENANT, key: FAKE_KEY, tier: "detail" },
      { baseUrl: "http://127.0.0.1:3100", fetchImpl: fetchSpy },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.body).toBe("Full content of the vault page");
      expect(result.data.sha256).toBe("def456");
    }
  });
});
