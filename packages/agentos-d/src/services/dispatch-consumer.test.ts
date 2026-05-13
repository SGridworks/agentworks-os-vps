import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../db/migrations/index.js";
import {
  DispatchConsumer,
  stubAdapter,
  dispatchConsumerEnabled,
  dispatchConsumerOptionsFromEnv,
  type AgentAdapter,
  type AdapterOutcome,
} from "./dispatch-consumer.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const COMPANY = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

let sqlite: Database.Database;

function seedAgent(id: string, status = "active"): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO execution_companies (id, tenant_id, name, status, metadata_json, source, created_at, updated_at)
       VALUES (?, ?, 'Co', 'active', '{}', 'awos', ?, ?)`
    )
    .run(COMPANY, TENANT, now, now);
  sqlite
    .prepare(
      `INSERT INTO execution_agents
         (id, tenant_id, company_id, name, role, status, config_json, model, created_at, updated_at)
       VALUES (?, ?, ?, 'A', 'BackendEngineer', ?, '{}', 'kimi-k2', ?, ?)`
    )
    .run(id, TENANT, COMPANY, status, now, now);
}

function enqueue(opts: { id: string; tenantId?: string; targetAgentId: string; taskKind?: string }): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO dispatch_queue
         (id, tenant_id, task_kind, target_agent_id, input, status, created_at)
       VALUES (?, ?, ?, ?, '{"hello":"world"}', 'queued', ?)`
    )
    .run(opts.id, opts.tenantId ?? TENANT, opts.taskKind ?? "test.task", opts.targetAgentId, now);
}

function getDispatch(id: string): Record<string, unknown> {
  return sqlite.prepare("SELECT * FROM dispatch_queue WHERE id = ?").get(id) as Record<string, unknown>;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  migrate(sqlite);
});

afterEach(() => {
  sqlite.close();
});

describe("DispatchConsumer.tick", () => {
  it("does nothing when queue is empty", async () => {
    const consumer = new DispatchConsumer({ sqlite });
    const r = await consumer.tick();
    expect(r).toEqual({ scanned: 0, claimed: 0, completed: 0, failed: 0 });
  });

  it("claims queued → dispatched → completed via stub adapter", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    enqueue({ id: "d1", targetAgentId: agentId });

    const consumer = new DispatchConsumer({ sqlite });
    const r = await consumer.tick();
    expect(r).toEqual({ scanned: 1, claimed: 1, completed: 1, failed: 0 });

    const row = getDispatch("d1");
    expect(row.status).toBe("completed");
    expect(row.dispatched_at).not.toBeNull();
    expect(row.completed_at).not.toBeNull();
  });

  it("marks failed when target agent is missing", async () => {
    enqueue({ id: "d-orphan", targetAgentId: "ffffffff-ffff-ffff-ffff-ffffffffffff" });
    const consumer = new DispatchConsumer({ sqlite });
    const r = await consumer.tick();
    expect(r.failed).toBe(1);
    const row = getDispatch("d-orphan");
    expect(row.status).toBe("failed");
    expect(row.error).toBe("target agent not found");
  });

  it("marks failed when tenant doesn't match", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    enqueue({
      id: "d-cross-tenant",
      targetAgentId: agentId,
      tenantId: "22222222-2222-2222-2222-222222222222",
    });
    const consumer = new DispatchConsumer({ sqlite });
    const r = await consumer.tick();
    expect(r.failed).toBe(1);
    expect((getDispatch("d-cross-tenant") as { error: string }).error).toBe("tenant mismatch");
  });

  it("skips paused agents and marks the dispatch failed", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId, "paused");
    enqueue({ id: "d-paused", targetAgentId: agentId });
    const consumer = new DispatchConsumer({ sqlite });
    const r = await consumer.tick();
    expect(r.failed).toBe(1);
    expect((getDispatch("d-paused") as { error: string }).error).toContain("paused");
  });

  it("reads autopilot risk information from input JSON", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    
    // Enqueue with autopilot risk information
    const now = new Date().toISOString();
    const inputWithRisk = {
      hello: "world",
      riskScore: 0.25,
      reasons: ["test.reason", "another.reason"],
      autopilotDecision: "allow",
    };
    sqlite
      .prepare(
        `INSERT INTO dispatch_queue
           (id, tenant_id, task_kind, target_agent_id, input, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`
      )
      .run("d-risk", TENANT, "test.task", agentId, JSON.stringify(inputWithRisk), now);

    let capturedInput: AdapterInput | undefined;
    const capturingAdapter: AgentAdapter = {
      async run(input) {
        capturedInput = input;
        return { status: "completed" };
      },
    };
    
    const consumer = new DispatchConsumer({ sqlite, adapter: capturingAdapter });
    const r = await consumer.tick();
    expect(r.completed).toBe(1);
    
    expect(capturedInput).toBeDefined();
    expect(capturedInput!.riskScore).toBe(0.25);
    expect(capturedInput!.reasons).toEqual(["test.reason", "another.reason"]);
    expect(capturedInput!.autopilotDecision).toBe("allow");
    expect(capturedInput!.payload).toMatchObject({ hello: "world" });
  });

  it("converts thrown adapter exceptions into failed", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    enqueue({ id: "d-throws", targetAgentId: agentId });

    const throwing: AgentAdapter = {
      async run() {
        throw new Error("boom");
      },
    };
    const consumer = new DispatchConsumer({ sqlite, adapter: throwing });
    const r = await consumer.tick();
    expect(r.failed).toBe(1);
    expect((getDispatch("d-throws") as { error: string }).error).toBe("boom");
  });

  it("accumulates token + cost counters into runtime_state on success", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    enqueue({ id: "d-cost", targetAgentId: agentId });

    const tokenAdapter: AgentAdapter = {
      async run() {
        const out: AdapterOutcome = {
          status: "completed",
          tokensInput: 100,
          tokensOutput: 50,
          tokensCached: 10,
          costCents: 7,
        };
        return out;
      },
    };
    const consumer = new DispatchConsumer({ sqlite, adapter: tokenAdapter });
    await consumer.tick();

    enqueue({ id: "d-cost-2", targetAgentId: agentId });
    await consumer.tick();

    const rs = sqlite
      .prepare(
        "SELECT total_input_tokens, total_output_tokens, total_cached_input_tokens, total_cost_cents FROM execution_agent_runtime_state WHERE agent_id = ?"
      )
      .get(agentId) as {
      total_input_tokens: number;
      total_output_tokens: number;
      total_cached_input_tokens: number;
      total_cost_cents: number;
    };
    expect(rs).toMatchObject({
      total_input_tokens: 200,
      total_output_tokens: 100,
      total_cached_input_tokens: 20,
      total_cost_cents: 14,
    });

    // last_heartbeat_at should be stamped on the agent
    const agent = sqlite
      .prepare("SELECT last_heartbeat_at FROM execution_agents WHERE id = ?")
      .get(agentId) as { last_heartbeat_at: string | null };
    expect(agent.last_heartbeat_at).not.toBeNull();
  });

  it("processes a batch up to batchSize", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    for (let i = 0; i < 8; i++) enqueue({ id: `d-${i}`, targetAgentId: agentId });

    const consumer = new DispatchConsumer({ sqlite, batchSize: 3 });
    const first = await consumer.tick();
    expect(first.scanned).toBe(3);
    expect(first.completed).toBe(3);

    const second = await consumer.tick();
    expect(second.scanned).toBe(3);

    const remaining = sqlite
      .prepare("SELECT COUNT(*) AS c FROM dispatch_queue WHERE status = 'queued'")
      .get() as { c: number };
    expect(remaining.c).toBe(2);
  });

  it("two concurrent ticks do not double-claim the same row", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    enqueue({ id: "d-race", targetAgentId: agentId });

    const slowAdapter: AgentAdapter = {
      async run() {
        await new Promise((r) => setTimeout(r, 30));
        return { status: "completed" };
      },
    };
    const consumer = new DispatchConsumer({ sqlite, adapter: slowAdapter });
    const [a, b] = await Promise.all([consumer.tick(), consumer.tick()]);
    const totalCompleted = a.completed + b.completed;
    expect(totalCompleted).toBe(1);
    const row = getDispatch("d-race");
    expect(row.status).toBe("completed");
  });

  it("does not re-process completed rows on subsequent ticks", async () => {
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    enqueue({ id: "d-once", targetAgentId: agentId });
    const consumer = new DispatchConsumer({ sqlite });
    await consumer.tick();
    const second = await consumer.tick();
    expect(second).toEqual({ scanned: 0, claimed: 0, completed: 0, failed: 0 });
  });
});

describe("DispatchConsumer.start/stop", () => {
  it("ticks on the configured interval and stops cleanly", async () => {
    vi.useFakeTimers();
    const agentId = "aaaaaaaa-1111-1111-1111-111111111111";
    seedAgent(agentId);
    enqueue({ id: "d-int", targetAgentId: agentId });

    const consumer = new DispatchConsumer({ sqlite, intervalMs: 100 });
    consumer.start();
    await vi.advanceTimersByTimeAsync(120);
    consumer.stop();

    const row = getDispatch("d-int");
    expect(row.status).toBe("completed");
    vi.useRealTimers();
  });
});

describe("env helpers", () => {
  it("dispatchConsumerEnabled defaults ON, can be disabled with explicit 'false'", () => {
    expect(dispatchConsumerEnabled({})).toBe(true);
    expect(dispatchConsumerEnabled({ AGENTOS_DISPATCH_CONSUMER_ENABLED: "true" })).toBe(true);
    expect(dispatchConsumerEnabled({ AGENTOS_DISPATCH_CONSUMER_ENABLED: "false" })).toBe(false);
  });

  it("dispatchConsumerOptionsFromEnv parses interval and batch", () => {
    expect(dispatchConsumerOptionsFromEnv({})).toEqual({ intervalMs: 5000, batchSize: 5 });
    expect(
      dispatchConsumerOptionsFromEnv({
        AGENTOS_DISPATCH_CONSUMER_INTERVAL_MS: "1000",
        AGENTOS_DISPATCH_CONSUMER_BATCH: "20",
      })
    ).toEqual({ intervalMs: 1000, batchSize: 20 });
    expect(
      dispatchConsumerOptionsFromEnv({
        AGENTOS_DISPATCH_CONSUMER_INTERVAL_MS: "not-a-number",
      })
    ).toEqual({ intervalMs: 5000, batchSize: 5 });
  });
});

describe("stubAdapter", () => {
  it("returns completed status", async () => {
    const out = await stubAdapter.run({
      taskId: "t",
      tenantId: TENANT,
      taskKind: "x.y",
      targetAgentId: "a",
      agent: { id: "a", tenantId: TENANT, role: null, model: null, adapterType: null, instructionsPath: null },
      payload: {},
    });
    expect(out.status).toBe("completed");
  });
});
