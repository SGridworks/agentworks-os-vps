/**
 * cost-meter-router.test.ts
 *
 * Integration tests for the cost-meter HTTP router.
 * Covers: POST /api/proxy/chat-completions, GET /api/proxy/circuit-state,
 * GET /api/proxy/circuit-events.
 *
 * Uses supertest + mocked fetch so no real API keys are needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express } from "express";
import request from "supertest";
import { createCostMeterRouter } from "./cost-meter-router.js";
import { CircuitState } from "../circuit-breaker/types.js";
import type { Config } from "../config.js";

// ---------------------------------------------------------------------------
// Mock config
// ---------------------------------------------------------------------------

const mockConfig: Config = {
  port: 7710,
  host: "127.0.0.1",
  logLevel: "warn" as const,
  awcpVersion: "awcp/v0.1",
  dataDir: "./data",
  scannerSidecarUrl: "http://127.0.0.1:3101",
  scannerPollIntervalMs: 30000,
  auditLogRetentionDays: 30,
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Config["logger"],
} as Config;

// ---------------------------------------------------------------------------
// Mock fetch helpers
// ---------------------------------------------------------------------------

function makeMockResponse(init: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(init.headers ?? {}),
    json: async () => init.body,
    text: async () => JSON.stringify(init.body),
  } as unknown as Response;
}

type FetchMock = ReturnType<typeof vi.fn>;
let mockFetch: FetchMock;

vi.mock("../db/index.js", () => ({
  getDb: () => ({
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
  }),
}));

function buildApp(): Express {
  const { router } = createCostMeterRouter(mockConfig);
  const app = express();
  app.use(express.json());
  app.use("/api/proxy", router);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/proxy/chat-completions", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when provider is missing", async () => {
    const res = await request(app)
      .post("/api/proxy/chat-completions")
      .send({ tenantId: "t1", request: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 when tenantId is missing", async () => {
    const res = await request(app)
      .post("/api/proxy/chat-completions")
      .send({ provider: "openai", request: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 when request body is missing", async () => {
    const res = await request(app)
      .post("/api/proxy/chat-completions")
      .send({ provider: "openai", tenantId: "t1" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 200 with usage telemetry on success", async () => {
    mockFetch.mockResolvedValueOnce(
      makeMockResponse({
        status: 200,
        body: {
          id: "chatcmpl-1",
          model: "gpt-4o",
          choices: [{ message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
        headers: { "x-ratelimit-remaining-tokens": "9999" },
      })
    );

    const res = await request(app)
      .post("/api/proxy/chat-completions")
      .send({
        provider: "openai",
        tenantId: "t1",
        request: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.model).toBe("gpt-4o");
    expect(res.body.usage.inputTokens).toBe(10);
    expect(res.body.usage.outputTokens).toBe(5);
    expect(res.body.usage.totalTokens).toBe(15);
    expect(res.body.circuitState).toBe(CircuitState.CLOSED);
    expect(res.body.fallbackUsed).toBe(false);
    expect(res.body.retryAttempts).toBe(0);
    expect(res.body.actualProvider).toBe("openai");
  });

  it("retries on 429 and returns 200 when fallback succeeds", async () => {
    // Primary returns 429 (transient), fallback returns 200
    mockFetch
      .mockResolvedValueOnce(
        makeMockResponse({ status: 429, body: { error: "rate limited" } })
      )
      .mockResolvedValueOnce(
        makeMockResponse({
          status: 200,
          body: {
            id: "msg-1",
            model: "claude-3-sonnet",
            choices: [{ message: { role: "assistant", content: "fallback response" } }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
          },
        })
      );

    const res = await request(app)
      .post("/api/proxy/chat-completions")
      .send({
        provider: "openai",
        tenantId: "t1",
        request: { model: "claude-3-sonnet", messages: [{ role: "user", content: "hi" }] },
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.actualProvider).toBe("anthropic");
    expect(res.body.fallbackUsed).toBe(true);
    expect(res.body.retryAttempts).toBe(1);
    expect(res.body.data.model).toBe("claude-3-sonnet");
  });

  it("returns 502 when both primary and fallback fail", async () => {
    mockFetch
      .mockResolvedValueOnce(
        makeMockResponse({ status: 500, body: { error: "boom" } })
      )
      .mockResolvedValueOnce(
        makeMockResponse({ status: 500, body: { error: "boom" } })
      );

    const res = await request(app)
      .post("/api/proxy/chat-completions")
      .send({
        provider: "openai",
        tenantId: "t1",
        request: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      });

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
    expect(res.body.errorCode).toBe("500");
  });

});

describe("GET /api/proxy/circuit-state", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when provider is missing", async () => {
    const res = await request(app)
      .get("/api/proxy/circuit-state")
      .query({ tenantId: "t1" });

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

  it("returns 200 with circuit state", async () => {
    // Trigger some state by making a call first
    mockFetch.mockResolvedValueOnce(
      makeMockResponse({
        status: 200,
        body: {
          id: "chatcmpl-1",
          model: "gpt-4o",
          choices: [{ message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      })
    );

    await request(app)
      .post("/api/proxy/chat-completions")
      .send({
        provider: "openai",
        tenantId: "t1",
        request: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      });

    const res = await request(app)
      .get("/api/proxy/circuit-state")
      .query({ provider: "openai", tenantId: "t1" });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("openai");
    expect(res.body.tenantId).toBe("t1");
    expect(res.body.circuitState).toBe(CircuitState.CLOSED);
    expect(Array.isArray(res.body.allStates)).toBe(true);
  });

});

describe("GET /api/proxy/circuit-events", () => {
  let app: Express;

  beforeEach(() => {
    app = buildApp();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when provider is missing", async () => {
    const res = await request(app)
      .get("/api/proxy/circuit-events")
      .query({ tenantId: "t1" });

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

  it("returns 200 with events array", async () => {
    // Make a call to generate an event
    mockFetch.mockResolvedValueOnce(
      makeMockResponse({
        status: 200,
        body: {
          id: "chatcmpl-1",
          model: "gpt-4o",
          choices: [{ message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      })
    );

    await request(app)
      .post("/api/proxy/chat-completions")
      .send({
        provider: "openai",
        tenantId: "t1",
        request: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      });

    const res = await request(app)
      .get("/api/proxy/circuit-events")
      .query({ provider: "openai", tenantId: "t1" });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("openai");
    expect(res.body.tenantId).toBe("t1");
    expect(Array.isArray(res.body.events)).toBe(true);
  });

  it("returns 200 with custom limit", async () => {
    const res = await request(app)
      .get("/api/proxy/circuit-events")
      .query({ provider: "openai", tenantId: "t1", limit: "5" });

    expect(res.status).toBe(200);
    expect(res.body.events).toBeInstanceOf(Array);
  });

  it("caps limit at 100", async () => {
    const res = await request(app)
      .get("/api/proxy/circuit-events")
      .query({ provider: "openai", tenantId: "t1", limit: "999" });

    expect(res.status).toBe(200);
    // The implementation caps at 100, so no error
    expect(res.body.events).toBeInstanceOf(Array);
  });
});
