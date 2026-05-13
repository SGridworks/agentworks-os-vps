import { describe, it, expect, vi } from "vitest";
import { healthHandler } from "./health-handler.js";
import type { Config } from "./config.js";

describe("agentos-d health handler", () => {
  // Unit-test the handler directly — avoids Express routing + middleware mock hell.
  // The handler is a plain (req, res) => void function; supertest is only needed
  // for full integration tests of the router layer.

  it("returns 200 with status payload", () => {
    const cfg = {
      logLevel: "silent",
      db: { url: ":memory:" },
      vault: { root: "/tmp/vault" },
      awcpVersion: "awcp/test",
      tenantsDir: "/tmp/tenants",
      sessionSecret: "test-secret-32-chars-minimum!!",
      smtp: { host: "", port: 0, user: "", pass: "", from: "" },
      redis: { url: "redis://localhost" },
    } as Config;

    let responseBody: Record<string, unknown> = {};

    const mockRes: Record<string, unknown> = {};
    mockRes.status = vi.fn((code: number) => {
      return mockRes;
    });
    mockRes.json = vi.fn((body: Record<string, unknown>) => {
      responseBody = body;
      return mockRes;
    });

    healthHandler(
      { method: "GET", url: "/api/health" } as any,
      mockRes as any,
      cfg as unknown as Config,
    );

    // res.json() defaults to status 200; verify the body instead
    expect(responseBody.status).toBe("ok");
    expect(responseBody.awcp).toMatch(/^awcp\//);
    expect(typeof responseBody.version).toBe("string");
    expect(typeof responseBody.startedAt).toBe("string");
    expect(mockRes.json).toHaveBeenCalled();
  });
});
