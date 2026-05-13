/**
 * cost-meter-smoke.test.ts
 *
 * Smoke tests for the cost-meter proxy using synthetic upstream failures.
 * These run without real API keys by injecting a mock fetch.
 *
 * Scenarios:
 * 1. Circuit opens after threshold of hard failures, blocks subsequent calls
 * 2. Half-open probe succeeds → circuit closes
 * 3. 429 transient error triggers fallback retry without counting toward CB
 * 4. network_error (ECONNREFUSED) does not trigger retry and does not count toward CB
 * 5. Per-tenant isolation: tenant A's OPEN state does not affect tenant B
 */

import { describe, it, expect, vi } from "vitest";
import { pino } from "pino";
import { type FetchLike } from "./CostMeter.js";
import { CircuitState } from "../circuit-breaker/types.js";

const mockConfig = {
  port: 7710,
  host: "127.0.0.1",
  logLevel: "warn" as const,
  awcpVersion: "awcp/v0.1",
  dataDir: "./data",
  scannerSidecarUrl: "http://127.0.0.1:3101",
  scannerPollIntervalMs: 30000,
  auditLogRetentionDays: 30,
  logger: pino({ level: "warn" }),
};

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeMockResponse(init: {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}): Response {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    headers: new Headers(init.headers ?? {}),
    json: async () => init.body,
    text: async () => JSON.stringify(init.body),
  } as unknown as Response;
}

/** Simple mock that throws an error for a given URL. */
function makeErrorMock(error: Error): FetchLike {
  return vi.fn(async (url: string | URL | Request) => {
    throw error;
  }) as unknown as FetchLike;
}

/** Sequential mock: returns the next item in the sequence each call. */
function makeSequentialMock(
  responses: Array<{ status?: number; body?: unknown; error?: Error }>,
): FetchLike {
  let idx = 0;
  return vi.fn(async () => {
    const r = responses[idx % responses.length];
    idx++;
    if (r.error) throw r.error;
    return makeMockResponse({ status: r.status, body: r.body });
  }) as unknown as FetchLike;
}

/** Counted mock: tracks call counts per URL fragment. */
function makeCountedMock(
  handlers: Record<string, { status?: number; body?: unknown; error?: Error }>,
): FetchLike & { openaiCalls: number; anthropicCalls: number } {
  const counts: Record<string, number> = Object.fromEntries(Object.keys(handlers).map((k) => [k, 0]));
  // Use vi.fn() as the base, then attach custom properties
  const mock = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    for (const [frag, cfg] of Object.entries(handlers)) {
      if (u.includes(frag)) {
        counts[frag]++;
        if (cfg.error) throw cfg.error;
        return makeMockResponse({ status: cfg.status, body: cfg.body });
      }
    }
    throw new Error(`Unexpected URL: ${u}`);
  }) as unknown as FetchLike & { openaiCalls: number; anthropicCalls: number };

  // Attach counted call accessors
  Object.defineProperty(mock, "openaiCalls", { get: () => counts["openai"] ?? 0 });
  Object.defineProperty(mock, "anthropicCalls", { get: () => counts["anthropic"] ?? 0 });
  return mock;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe("cost-meter smoke: synthetic upstream failures", () => {
  describe("circuit opens after hard failures, blocks subsequent calls", () => {
    it("blocks calls when OPEN and probe interval has not elapsed", async () => {
      const { CostMeter } = await import("./CostMeter.js");

      const mockFetch = vi.fn(async () => {
        return makeMockResponse({ status: 500, body: { error: "boom" } });
      }) as unknown as FetchLike;

      const costMeter = new CostMeter(
        mockConfig,
        [
          { name: "openai", endpoint: "https://openai/v1", apiKey: "x", isPrimary: true, fallbackOrder: 0 },
          { name: "anthropic", endpoint: "https://anthropic/v1", apiKey: "x", isPrimary: false, fallbackOrder: 1 },
        ],
        mockFetch,
      );

      // Drive to OPEN: 10 hard (non-transient) failures
      for (let i = 0; i < 10; i++) {
        const r = await costMeter.chatCompletions("openai", "t1", { model: "gpt-4", messages: [] });
        expect(r.success).toBe(false);
      }

      expect(costMeter.getCircuitState("openai", "t1")).toBe(CircuitState.OPEN);

      // Force probe time to the FUTURE so shouldAllow returns false
      const cb = (costMeter as unknown as {
        circuitBreaker: { states: Map<string, Record<string, unknown>> };
      }).circuitBreaker;
      const st = cb.states.get("openai:t1")!;
      st.nextProbeAt = new Date(Date.now() + 300_000); // 5 min from now

      // Additional call — should return failure without issuing a fetch
      const callsBefore = mockFetch.mock.callCount;
      const blocked = await costMeter.chatCompletions("openai", "t1", { model: "gpt-4", messages: [] });
      expect(blocked.success).toBe(false);
      expect(mockFetch.mock.callCount).toBe(callsBefore); // no new fetch
    });
  });

  describe("half-open probe succeeds, circuit closes", () => {
    it("closes circuit when probe call returns 200", async () => {
      const { CostMeter } = await import("./CostMeter.js");

      let callCount = 0;
      const mockFetch = vi.fn(async () => {
        callCount++;
        return makeMockResponse({
          status: callCount <= 10 ? 500 : 200,
          body:
            callCount <= 10
              ? { error: "boom" }
              : { id: "ok", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        });
      }) as unknown as FetchLike;

      const costMeter = new CostMeter(
        mockConfig,
        [{ name: "openai", endpoint: "https://openai/v1", apiKey: "x", isPrimary: true, fallbackOrder: 0 }],
        mockFetch,
      );

      // Drive to OPEN
      for (let i = 0; i < 10; i++) {
        await costMeter.chatCompletions("openai", "t1", { model: "gpt-4", messages: [] });
      }
      expect(costMeter.getCircuitState("openai", "t1")).toBe(CircuitState.OPEN);

      // Force probe time to the past
      const cb = (costMeter as unknown as {
        circuitBreaker: { states: Map<string, Record<string, unknown>> };
      }).circuitBreaker;
      cb.states.get("openai:t1")!.nextProbeAt = new Date(Date.now() - 1000);

      // Probe succeeds → circuit closes
      const probeResult = await costMeter.chatCompletions("openai", "t1", { model: "gpt-4", messages: [] });
      expect(probeResult.success).toBe(true);
      expect(costMeter.getCircuitState("openai", "t1")).toBe(CircuitState.CLOSED);
    });
  });

  describe("429 triggers fallback retry, does not count toward CB threshold", () => {
    it("retries anthropic after openai 429, leaves openai CLOSED", async () => {
      const { CostMeter } = await import("./CostMeter.js");

      const mockFetch = makeCountedMock({
        openai: { status: 429, body: { error: "rate limited" } },
        anthropic: { status: 200, body: { id: "ok", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } },
      });

      const costMeter = new CostMeter(
        mockConfig,
        [
          { name: "openai", endpoint: "https://openai/v1", apiKey: "x", isPrimary: true, fallbackOrder: 0 },
          { name: "anthropic", endpoint: "https://anthropic/v1", apiKey: "x", isPrimary: false, fallbackOrder: 1 },
        ],
        mockFetch,
      );

      const result = await costMeter.chatCompletions("openai", "t1", { model: "gpt-4", messages: [] });

      expect(result.success).toBe(true);
      expect(result.actualProvider).toBe("anthropic");
      expect(result.fallbackUsed).toBe(true);
      expect(result.retryAttempts).toBe(1);
      expect(costMeter.getCircuitState("openai", "t1")).toBe(CircuitState.CLOSED);
      expect(mockFetch.openaiCalls).toBe(1);
      expect(mockFetch.anthropicCalls).toBe(1);
    });
  });

  describe("ECONNREFUSED (network_error) does not trigger retry and does not count toward CB", () => {
    it("returns network_error, no fallback attempted, circuit stays CLOSED", async () => {
      const { CostMeter } = await import("./CostMeter.js");

      const netError = new Error("fetch failed");
      (netError as Error & { code: string }).code = "ECONNREFUSED";

      const mockFetch = makeCountedMock({
        openai: { error: netError },
        anthropic: { status: 200, body: { id: "ok", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } },
      });

      const costMeter = new CostMeter(
        mockConfig,
        [
          { name: "openai", endpoint: "https://openai/v1", apiKey: "x", isPrimary: true, fallbackOrder: 0 },
          { name: "anthropic", endpoint: "https://anthropic/v1", apiKey: "x", isPrimary: false, fallbackOrder: 1 },
        ],
        mockFetch,
      );

      const result = await costMeter.chatCompletions("openai", "t1", { model: "gpt-4", messages: [] });

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("network_error");
      expect(result.fallbackUsed).toBe(false); // no retry for network errors
      expect(costMeter.getCircuitState("openai", "t1")).toBe(CircuitState.CLOSED);
      expect(mockFetch.openaiCalls).toBe(1);
      expect(mockFetch.anthropicCalls).toBe(0); // fallback never attempted
    });
  });

  describe("per-tenant isolation", () => {
    it("tenant A circuit OPEN does not affect tenant B", async () => {
      const { CostMeter } = await import("./CostMeter.js");

      const mockFetch = vi.fn(async () => {
        return makeMockResponse({ status: 500, body: { error: "boom" } });
      }) as unknown as FetchLike;

      const costMeter = new CostMeter(
        mockConfig,
        [{ name: "openai", endpoint: "https://openai/v1", apiKey: "x", isPrimary: true, fallbackOrder: 0 }],
        mockFetch,
      );

      // Drive tenant-a to OPEN
      for (let i = 0; i < 10; i++) {
        await costMeter.chatCompletions("openai", "tenant-a", { model: "gpt-4", messages: [] });
      }

      expect(costMeter.getCircuitState("openai", "tenant-a")).toBe(CircuitState.OPEN);
      expect(costMeter.getCircuitState("openai", "tenant-b")).toBe(CircuitState.CLOSED);
    });
  });
});
