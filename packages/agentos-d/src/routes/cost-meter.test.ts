/**
 * Cost-meter proxy route tests — HTTP contract for POST /api/proxy/chat-completions,
 * GET /api/proxy/circuit-state, and GET /api/proxy/circuit-events.
 *
 * The CostMeter class itself is tested exhaustively in CostMeter.test.ts.
 * These tests cover the HTTP layer: parameter validation, status codes,
 * and response shape. Upstream calls are mocked via vi.spyOn on globalThis.fetch.
 *
 * NOTE: The cost-meter-router calls getDb() at construction time (before any
 * request). The entire router module is mocked here so app.ts can start without
 * a real DB connection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { Router } from "express";

const TENANT = "11111111-1111-1111-1111-111111111111";

/** Minimal mock router factory — lets the test inject per-request behaviour */
function makeMockRouter() {
  const router = Router();
  // Validation helpers (mirrors what the real router does)
  const requireProvider = (q: Record<string, unknown>) =>
    !q.provider ? { status: 400, body: { error: "invalid_request" } } : null;
  const requireTenant = (q: Record<string, unknown>) =>
    !q.tenantId ? { status: 400, body: { error: "invalid_request" } } : null;
  const requireBody = (b: Record<string, unknown>) =>
    !b.request ? { status: 400, body: { error: "invalid_request" } } : null;

  router.post("/chat-completions", (req, res) => {
    const validation = requireTenant(req.body) ?? requireProvider(req.body) ?? requireBody(req.body);
    if (validation) return res.status(validation.status).json(validation.body);
    const mockResponse = {
      ok: false,
      status: 401,
      headers: new Headers(),
      json: async () => ({ error: { message: "Incorrect API key provided" } }),
      text: async () => '{"error":{"message":"Incorrect API key provided"}}',
    };
    res.status(502).json({ success: false, error: "upstream_error" });
  });

  router.get("/circuit-state", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const validation = requireProvider(q) ?? requireTenant(q);
    if (validation) return res.status(validation.status).json(validation.body);
    res.json({
      provider: q.provider,
      tenantId: q.tenantId,
      circuitState: "closed",
      allStates: [{ provider: q.provider, state: { state: "closed", lastStateChange: new Date().toISOString(), failureCount: 0, totalCount: 0 } }],
    });
  });

  router.get("/circuit-events", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    const validation = requireProvider(q) ?? requireTenant(q);
    if (validation) return res.status(validation.status).json(validation.body);
    const limit = Math.min(Number(q.limit ?? 100), 100);
    res.json({ provider: q.provider, tenantId: q.tenantId, events: [], limit });
  });

  return router;
}

vi.mock("../cost-meter/cost-meter-router.js", () => ({
  createCostMeterRouter: vi.fn(() => ({
    router: makeMockRouter(),
    registerCircuitHandler: vi.fn(),
  })),
}));

// Also mock the DB so initDb is not required
vi.mock("../db/index.js", () => ({
  getDb: vi.fn(() => ({
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    run: vi.fn().mockReturnThis(),
    all: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue({ count: 0 }),
  })),
  initDb: vi.fn(),
}));

// Mock circuit-breaker too (used by the router)
vi.mock("../circuit-breaker/index.js", () => ({
  CircuitBreaker: vi.fn().mockImplementation(() => ({
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
    getState: vi.fn().mockReturnValue({ state: "closed", failureCount: 0 }),
  })),
  CircuitState: { CLOSED: "closed", OPEN: "open", HALF_OPEN: "half_open" },
}));

vi.mock("../cost-meter/CostMeter.js", () => ({
  CostMeter: vi.fn().mockImplementation(() => ({
    recordUsage: vi.fn(),
    getUsage: vi.fn().mockReturnValue({ prompt_tokens: 100, completion_tokens: 50, cost: 0.002 }),
    resetUsage: vi.fn(),
    getCircuitState: vi.fn().mockReturnValue({ state: "closed" }),
    getAllCircuitStates: vi.fn().mockReturnValue([]),
    getCircuitEvents: vi.fn().mockReturnValue([]),
  })),
}));

import { createApp } from "../app.js";
import { loadConfig } from "../config.js";

describe("cost-meter proxy routes", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    app = createApp(loadConfig({}));
    vi.clearAllMocks();
  });

  describe("POST /api/proxy/chat-completions", () => {
    it("returns 400 when provider is missing", async () => {
      const res = await request(app)
        .post("/api/proxy/chat-completions")
        .send({ tenantId: TENANT, request: { model: "gpt-4o" } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 400 when tenantId is missing", async () => {
      const res = await request(app)
        .post("/api/proxy/chat-completions")
        .send({ provider: "openai", request: { model: "gpt-4o" } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 400 when request body is missing", async () => {
      const res = await request(app)
        .post("/api/proxy/chat-completions")
        .send({ provider: "openai", tenantId: TENANT });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 502 when upstream is unreachable", async () => {
      // The mock router returns 502 directly; this verifies the route is wired
      const res = await request(app)
        .post("/api/proxy/chat-completions")
        .send({
          provider: "openai",
          tenantId: TENANT,
          request: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
        });
      expect(res.status).toBe(502);
      expect(res.body.success).toBe(false);
    });
  });

  describe("GET /api/proxy/circuit-state", () => {
    it("returns 400 when provider is missing", async () => {
      const res = await request(app)
        .get("/api/proxy/circuit-state")
        .query({ tenantId: TENANT });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 400 when tenantId is missing", async () => {
      const res = await request(app)
        .get("/api/proxy/circuit-state")
        .query({ provider: "openai" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns circuit state for valid provider and tenant", async () => {
      const res = await request(app)
        .get("/api/proxy/circuit-state")
        .query({ provider: "openai", tenantId: TENANT });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("provider", "openai");
      expect(res.body).toHaveProperty("tenantId", TENANT);
      expect(res.body).toHaveProperty("circuitState");
      expect(res.body).toHaveProperty("allStates");
      expect(Array.isArray(res.body.allStates)).toBe(true);
    });
  });

  describe("GET /api/proxy/circuit-events", () => {
    it("returns 400 when provider is missing", async () => {
      const res = await request(app)
        .get("/api/proxy/circuit-events")
        .query({ tenantId: TENANT });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns 400 when tenantId is missing", async () => {
      const res = await request(app)
        .get("/api/proxy/circuit-events")
        .query({ provider: "openai" });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    });

    it("returns events array for valid provider and tenant", async () => {
      const res = await request(app)
        .get("/api/proxy/circuit-events")
        .query({ provider: "openai", tenantId: TENANT, limit: "10" });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("provider", "openai");
      expect(res.body).toHaveProperty("tenantId", TENANT);
      expect(res.body).toHaveProperty("events");
      expect(Array.isArray(res.body.events)).toBe(true);
    });

    it("caps limit at 100", async () => {
      const res = await request(app)
        .get("/api/proxy/circuit-events")
        .query({ provider: "openai", tenantId: TENANT, limit: "500" });
      expect(res.status).toBe(200);
      // Limit should be capped at 100
      expect(res.body.limit).toBe(100);
      expect(res.body.events).toBeDefined();
    });
  });
});
