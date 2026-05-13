/**
 * Simple smoke test for GET /api/admin/autopilot endpoint.
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../packages/agentos-d/src/app.js";
import type { Config } from "../packages/agentos-d/src/config.js";

function makeConfig(): Config {
  return {
    companyId: "00000000-0000-4000-8000-000000000001",
    logLevel: "silent",
    sessionSecret: "test-secret",
    listenPort: 0,
    vaultDir: "",
    dataDir: "",
    awosBaseUrl: "http://127.0.0.1:3100",
    awosApiKey: "test",
    jwtSecret: "test",
    googleClientId: "",
    googleClientSecret: "",
    redirectUrl: "",
    allowedOrigins: ["http://localhost:3000"],
    costMeterUrl: "",
    costMeterApiKey: "",
  };
}

describe("GET /api/admin/autopilot - smoke test", () => {
  it("should return 400 when tenantId is missing", async () => {
    const app = createApp(makeConfig());
    const res = await request(app).get("/api/admin/autopilot");
    
    // Should return 400, not 404
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("tenantId required");
  });

  it("should return 200 when tenantId is provided", async () => {
    const app = createApp(makeConfig());
    const res = await request(app).get("/api/admin/autopilot?tenantId=test-tenant-id");
    
    // Should return 200, not 404
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("safe");
    expect(res.body).toHaveProperty("needsApproval");
    expect(res.body).toHaveProperty("risky");
  });
});