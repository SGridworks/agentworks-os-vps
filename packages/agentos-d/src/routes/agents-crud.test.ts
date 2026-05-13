/**
 * Integration tests for the parity-gap agent endpoints:
 *   GET  /api/agents                       — tenant-wide list
 *   POST /api/agents/:agentId/resume       — recover from paused/error
 *
 * Real :memory: sqlite + real migrations so the tests exercise the actual
 * prepared statements and constraints.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "../db/migrations/index.js";

let sqlite: Database.Database;

vi.mock("../db/index.js", () => ({
  getDb: () => drizzle(sqlite),
  getSqlite: () => sqlite,
}));

vi.mock("../services/embed-client.js", () => ({
  EmbedClient: class {},
}));

vi.mock("../services/episode-from-run.js", () => ({
  maybeRecordEpisodeFromRun: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/insight-extractor.js", () => ({
  getInsightExtractor: () => null,
}));

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const COMPANY_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

let app: express.Express;

async function setupApp() {
  const { createExecutionRouter } = await import("./execution.js");
  const { createAdminRouter } = await import("./admin.js");
  app = express();
  app.use(express.json());
  app.use("/api", createExecutionRouter({} as never));
  app.use("/api/admin", createAdminRouter({} as never));
}

function seedCompany(tenantId: string, companyId: string, name: string): void {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      `INSERT INTO execution_companies
       (id, tenant_id, name, status, metadata_json, source, created_at, updated_at)
       VALUES (?, ?, ?, 'active', '{}', 'awos', ?, ?)`
    )
    .run(companyId, tenantId, name, now, now);
}

async function createAgent(body: Record<string, unknown>): Promise<string> {
  const res = await request(app).post("/api/agents").send(body);
  expect(res.status).toBe(201);
  return res.body.id;
}

beforeEach(async () => {
  sqlite = new Database(":memory:");
  migrate(sqlite);
  await setupApp();
});

afterEach(() => {
  sqlite.close();
  vi.clearAllMocks();
});

describe("POST /api/agents (create-time backfill)", () => {
  it("backfills structured columns from config.* on insert", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const res = await request(app)
      .post("/api/agents")
      .send({
        tenantId: TENANT_A,
        companyId: COMPANY_A,
        name: "Backfilled",
        role: "BackendEngineer",
        config: {
          adapterType: "claude_local",
          model: "kimi-k2-turbo-preview",
          instructionsPath: "agents/backend/AGENTS.md",
          capabilities: "writes routes",
          runtimeConfig: { heartbeat: { intervalSec: 30, wakeOnDemand: true } },
        },
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      adapterType: "claude_local",
      model: "kimi-k2-turbo-preview",
      instructionsPath: "agents/backend/AGENTS.md",
      capabilities: "writes routes",
      heartbeatIntervalSec: 30,
      wakeOnDemand: true,
    });

    const row = sqlite
      .prepare("SELECT * FROM execution_agents WHERE id = ?")
      .get(res.body.id) as Record<string, unknown>;
    expect(row.adapter_type).toBe("claude_local");
    expect(row.model).toBe("kimi-k2-turbo-preview");
    expect(row.instructions_path).toBe("agents/backend/AGENTS.md");
    expect(row.heartbeat_interval_sec).toBe(30);
    expect(row.wake_on_demand).toBe(1);
  });

  it("prefers config.adapterConfig.model over config.model", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const res = await request(app)
      .post("/api/agents")
      .send({
        tenantId: TENANT_A,
        companyId: COMPANY_A,
        name: "AdapterModel",
        config: {
          model: "fallback-model",
          adapterConfig: { model: "preferred-model" },
        },
      });
    expect(res.body.model).toBe("preferred-model");
  });

  it("leaves all structured columns null when config is empty", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const res = await request(app)
      .post("/api/agents")
      .send({ tenantId: TENANT_A, companyId: COMPANY_A, name: "Empty" });
    expect(res.body.adapterType).toBeNull();
    expect(res.body.model).toBeNull();
    expect(res.body.heartbeatIntervalSec).toBeNull();
    expect(res.body.wakeOnDemand).toBeNull();
  });

  it("rejects empty adapterConfig.model with 400", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const res = await request(app)
      .post("/api/agents")
      .send({
        tenantId: TENANT_A,
        companyId: COMPANY_A,
        name: "InvalidModel",
        config: { adapterType: "codex-cli", adapterConfig: { model: "" } },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("rejects negative heartbeat intervalSec with 400", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const res = await request(app)
      .post("/api/agents")
      .send({
        tenantId: TENANT_A,
        companyId: COMPANY_A,
        name: "InvalidHeartbeat",
        config: {
          adapterType: "codex-cli",
          adapterConfig: { model: "gpt-5" },
          runtimeConfig: { heartbeat: { intervalSec: -5, wakeOnDemand: true } },
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("rejects empty adapterType with 400", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const res = await request(app)
      .post("/api/agents")
      .send({
        tenantId: TENANT_A,
        companyId: COMPANY_A,
        name: "InvalidAdapter",
        config: { adapterType: "" },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});

describe("POST /api/agents/:agentId/wakeup", () => {
  it("queues a wakeup for an active agent", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const id = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "Active" });
    const res = await request(app)
      .post(`/api/agents/${id}/wakeup`)
      .send({ source: "test" });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
    const dispatch = sqlite
      .prepare("SELECT id FROM dispatch_queue WHERE id = ?")
      .get(res.body.dispatchId);
    expect(dispatch).toBeDefined();
  });

  it("rejects wakeup for paused agent with 409 agent_paused", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const id = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "P" });
    await request(app)
      .patch(`/api/agents/${id}`)
      .send({ status: "paused", pauseReason: "manual hold" });

    const res = await request(app)
      .post(`/api/agents/${id}/wakeup`)
      .send({ source: "test" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("agent_paused");
    expect(res.body.pauseReason).toBe("manual hold");

    const dispatchCount = sqlite
      .prepare("SELECT COUNT(*) AS c FROM dispatch_queue WHERE target_agent_id = ?")
      .get(id) as { c: number };
    expect(dispatchCount.c).toBe(0);

    const wakeupCount = sqlite
      .prepare("SELECT COUNT(*) AS c FROM execution_agent_wakeups WHERE agent_id = ?")
      .get(id) as { c: number };
    expect(wakeupCount.c).toBe(0);
  });

  it("rejects wakeup for retired agent with 409 agent_retired", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const id = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "R" });
    await request(app).patch(`/api/agents/${id}`).send({ status: "retired" });

    const res = await request(app)
      .post(`/api/agents/${id}/wakeup`)
      .send({ source: "test" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("agent_retired");
  });

  it("resume followed by wakeup succeeds", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const id = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "Q" });
    await request(app).patch(`/api/agents/${id}`).send({ status: "paused" });
    await request(app).post(`/api/agents/${id}/resume`).send({});

    const res = await request(app)
      .post(`/api/agents/${id}/wakeup`)
      .send({ source: "test" });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");
  });

  it("writes an action_log row for a successful wakeup", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const id = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "L" });
    await request(app)
      .post(`/api/agents/${id}/wakeup`)
      .send({ source: "operator", reason: "kick" });
    const rows = sqlite
      .prepare(
        "SELECT actor_id, action_kind, actor_label FROM action_log WHERE actor_id = ? AND action_kind = ?"
      )
      .all(id, "agent.wakeup") as Array<{ actor_id: string; action_kind: string; actor_label: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_label).toBe("operator");
  });

  it("does not write an action_log row when the wakeup is rejected (paused)", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const id = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "L2" });
    await request(app).patch(`/api/agents/${id}`).send({ status: "paused" });
    await request(app).post(`/api/agents/${id}/wakeup`).send({ source: "operator" });
    const count = sqlite
      .prepare(
        "SELECT COUNT(*) AS c FROM action_log WHERE actor_id = ? AND action_kind = 'agent.wakeup'"
      )
      .get(id) as { c: number };
    expect(count.c).toBe(0);
  });
});

describe("execution lifecycle audit (action_log)", () => {
  async function seedProjectAndIssue(): Promise<{ projectId: string; issueId: string; companyId: string }> {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const project = await request(app)
      .post(`/api/companies/${COMPANY_A}/projects`)
      .send({ tenantId: TENANT_A, name: "P" });
    const issue = await request(app)
      .post(`/api/companies/${COMPANY_A}/issues`)
      .send({ tenantId: TENANT_A, projectId: project.body.id, title: "T" });
    return { projectId: project.body.id, issueId: issue.body.id, companyId: COMPANY_A };
  }

  it("records issue.update on status transition", async () => {
    const { issueId } = await seedProjectAndIssue();
    await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress" });
    const rows = sqlite
      .prepare(
        "SELECT action_kind, payload_snapshot FROM action_log WHERE action_kind = 'issue.update'"
      )
      .all() as Array<{ action_kind: string; payload_snapshot: string }>;
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0].payload_snapshot) as Record<string, unknown>;
    expect(payload.issueId).toBe(issueId);
    expect(payload.status).toEqual({ from: "todo", to: "in_progress" });
  });

  it("does not record issue.update when nothing changed", async () => {
    const { issueId } = await seedProjectAndIssue();
    await request(app).patch(`/api/issues/${issueId}`).send({ title: "T" });
    const count = sqlite
      .prepare("SELECT COUNT(*) AS c FROM action_log WHERE action_kind = 'issue.update'")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("records issue.comment on POST comment", async () => {
    const { issueId } = await seedProjectAndIssue();
    await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "checking in", authorLabel: "Operator" });
    const rows = sqlite
      .prepare(
        "SELECT actor_label, payload_snapshot FROM action_log WHERE action_kind = 'issue.comment'"
      )
      .all() as Array<{ actor_label: string; payload_snapshot: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_label).toBe("Operator");
    const payload = JSON.parse(rows[0].payload_snapshot) as Record<string, unknown>;
    expect(payload.issueId).toBe(issueId);
    expect(payload.bodyPreview).toBe("checking in");
  });

  it("records run.<terminal> on runtime-state terminal transitions", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const id = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "R" });
    await request(app)
      .post(`/api/agents/${id}/runtime-state`)
      .send({ lastRunStatus: "running", lastRunId: "11111111-1111-1111-1111-111111111111" });
    await request(app)
      .post(`/api/agents/${id}/runtime-state`)
      .send({ lastRunStatus: "succeeded", lastRunId: "11111111-1111-1111-1111-111111111111" });

    const rows = sqlite
      .prepare(
        "SELECT action_kind FROM action_log WHERE actor_id = ? AND action_kind LIKE 'run.%'"
      )
      .all(id) as Array<{ action_kind: string }>;
    const kinds = rows.map((r) => r.action_kind);
    expect(kinds).toContain("run.succeeded");
    expect(kinds).not.toContain("run.running");
  });

  it("activity-log surfaces execution events", async () => {
    const { issueId } = await seedProjectAndIssue();
    const aid = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "A" });
    await request(app).patch(`/api/issues/${issueId}`).send({ status: "in_progress" });
    await request(app)
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "hi", authorLabel: "Operator" });
    await request(app).post(`/api/agents/${aid}/wakeup`).send({ source: "test" });

    const res = await request(app)
      .get("/api/admin/activity-log")
      .query({ tenantId: TENANT_A });
    expect(res.status).toBe(200);
    const kinds = res.body.map((r: { actionKind: string }) => r.actionKind);
    expect(kinds).toContain("issue.update");
    expect(kinds).toContain("issue.comment");
    expect(kinds).toContain("agent.wakeup");
  });

  it("triage-queue/assign records issue.assign", async () => {
    const { issueId } = await seedProjectAndIssue();
    const aid = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "Assignee" });
    const res = await request(app)
      .post("/api/admin/triage-queue/assign")
      .send({ issueId, assigneeAgentId: aid });
    expect(res.status).toBe(200);
    const rows = sqlite
      .prepare(
        "SELECT actor_id, action_kind, payload_snapshot FROM action_log WHERE action_kind = 'issue.assign'"
      )
      .all() as Array<{ actor_id: string; action_kind: string; payload_snapshot: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(aid);
    const payload = JSON.parse(rows[0].payload_snapshot) as Record<string, unknown>;
    expect(payload.issueId).toBe(issueId);
    expect(payload.to).toBe(aid);
  });
});

describe("GET /api/agents", () => {
  it("returns 400 when tenantId is missing", async () => {
    const res = await request(app).get("/api/agents");
    expect(res.status).toBe(400);
  });

  it("returns 400 when tenantId is not a uuid", async () => {
    const res = await request(app).get("/api/agents").query({ tenantId: "nope" });
    expect(res.status).toBe(400);
  });

  it("returns empty list when tenant has no agents", async () => {
    const res = await request(app).get("/api/agents").query({ tenantId: TENANT_A });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [] });
  });

  it("lists only agents for the requested tenant", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "Alpha" });
    await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "Bravo" });
    await createAgent({ tenantId: TENANT_B, name: "Other" });

    const res = await request(app).get("/api/agents").query({ tenantId: TENANT_A });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items.map((a: { name: string }) => a.name).sort()).toEqual(["Alpha", "Bravo"]);
  });

  it("filters by companyId when provided", async () => {
    const companyB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    seedCompany(TENANT_A, companyB, "Co B");
    await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "InA" });
    await createAgent({ tenantId: TENANT_A, companyId: companyB, name: "InB" });

    const res = await request(app)
      .get("/api/agents")
      .query({ tenantId: TENANT_A, companyId: COMPANY_A });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe("InA");
  });

  it("filters by status when provided", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const pausedId = await createAgent({
      tenantId: TENANT_A,
      companyId: COMPANY_A,
      name: "Paused",
    });
    await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "Active" });
    await request(app).patch(`/api/agents/${pausedId}`).send({ status: "paused" });

    const res = await request(app)
      .get("/api/agents")
      .query({ tenantId: TENANT_A, status: "paused" });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].name).toBe("Paused");
  });

  it("orders by name ascending", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "Charlie" });
    await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "Alpha" });
    await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "Bravo" });

    const res = await request(app).get("/api/agents").query({ tenantId: TENANT_A });
    expect(res.body.items.map((a: { name: string }) => a.name)).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
  });
});

describe("POST /api/agents/:agentId/resume", () => {
  it("returns 404 for unknown agent id", async () => {
    const res = await request(app)
      .post("/api/agents/00000000-0000-0000-0000-000000000000/resume")
      .send({});
    expect(res.status).toBe(404);
  });

  it("returns 404 for malformed agent id", async () => {
    const res = await request(app).post("/api/agents/not-a-uuid/resume").send({});
    expect(res.status).toBe(404);
  });

  it("flips paused agent to active and clears pause metadata", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const id = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "X" });
    await request(app)
      .patch(`/api/agents/${id}`)
      .send({ status: "paused", pauseReason: "manual hold" });

    const before = sqlite
      .prepare("SELECT status, pause_reason, paused_at FROM execution_agents WHERE id = ?")
      .get(id) as { status: string; pause_reason: string | null; paused_at: string | null };
    expect(before.status).toBe("paused");
    expect(before.pause_reason).toBe("manual hold");
    expect(before.paused_at).not.toBeNull();

    const res = await request(app).post(`/api/agents/${id}/resume`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.pauseReason).toBeNull();
    expect(res.body.pausedAt).toBeNull();
  });

  it("clears last_error on runtime_state by default", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const id = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "X" });
    await request(app).post(`/api/agents/${id}/runtime-state`).send({
      lastError: "kaboom",
      lastErrorAt: "2026-05-03T00:00:00Z",
    });

    await request(app).post(`/api/agents/${id}/resume`).send({});

    const rs = sqlite
      .prepare(
        "SELECT last_error, last_error_at FROM execution_agent_runtime_state WHERE agent_id = ?"
      )
      .get(id) as { last_error: string | null; last_error_at: string | null };
    expect(rs.last_error).toBeNull();
    expect(rs.last_error_at).toBeNull();
  });

  it("preserves last_error when clearLastError=false", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const id = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "X" });
    await request(app).post(`/api/agents/${id}/runtime-state`).send({
      lastError: "preserve me",
      lastErrorAt: "2026-05-03T00:00:00Z",
    });

    await request(app).post(`/api/agents/${id}/resume`).send({ clearLastError: false });

    const rs = sqlite
      .prepare("SELECT last_error FROM execution_agent_runtime_state WHERE agent_id = ?")
      .get(id) as { last_error: string | null };
    expect(rs.last_error).toBe("preserve me");
  });

  it("records a config revision audit row with source=resume", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const id = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "X" });
    await request(app).patch(`/api/agents/${id}`).send({ status: "paused" });

    await request(app)
      .post(`/api/agents/${id}/resume`)
      .send({ actorKind: "operator", actorId: "adam" });

    const revs = sqlite
      .prepare(
        "SELECT * FROM execution_agent_config_revisions WHERE agent_id = ?"
      )
      .all(id) as Array<{
      actor_kind: string;
      actor_id: string | null;
      source: string | null;
      changed_keys_json: string;
    }>;
    const resumeRev = revs.find((r) => r.source === "resume");
    expect(resumeRev).toBeDefined();
    expect(resumeRev!.actor_kind).toBe("operator");
    expect(resumeRev!.actor_id).toBe("adam");
    expect(JSON.parse(resumeRev!.changed_keys_json)).toContain("status");
  });

  it("is a no-op revision when agent is already active", async () => {
    seedCompany(TENANT_A, COMPANY_A, "Co A");
    const id = await createAgent({ tenantId: TENANT_A, companyId: COMPANY_A, name: "X" });

    await request(app).post(`/api/agents/${id}/resume`).send({});

    const revCount = sqlite
      .prepare("SELECT COUNT(*) AS c FROM execution_agent_config_revisions WHERE agent_id = ?")
      .get(id) as { c: number };
    expect(revCount.c).toBe(0);
  });
});
